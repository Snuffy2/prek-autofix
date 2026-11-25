import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MAX_BYTES } from "../../shared/src/artifact";
import { HOOK_SUPERVISOR_SCRIPT } from "./hook-supervisor";

export const GIT_CAPTURE_LIMIT_BYTES = DEFAULT_MAX_BYTES;
const GIT_INSPECTION_TIMEOUT_MS = 30_000;

export interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type Execute = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    streamUntrustedOutput?: boolean;
    streamLimitBytes?: number;
    captureLimitBytes?: number;
    superviseProcessTree?: boolean;
    trustedPythonPath?: string;
    timeoutDescription?: string;
    timeoutMs?: number;
  },
) => Promise<CommandResult>;

interface PrekPassOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  trustedPythonPath: string;
  maxLogBytes: number;
  timeoutMs: number;
}

export function executePrekPass(
  execute: Execute,
  args: string[],
  { cwd, env, trustedPythonPath, maxLogBytes, timeoutMs }: PrekPassOptions,
): Promise<CommandResult> {
  return execute("prek", args, {
    cwd,
    env,
    streamUntrustedOutput: true,
    streamLimitBytes: maxLogBytes,
    superviseProcessTree: true,
    trustedPythonPath,
    timeoutMs,
  });
}

interface GitWorktreeInspectionOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  trustedPythonPath: string;
  timeoutMs?: number;
}

export function executeGitWorktreeInspection(
  execute: Execute,
  command: string,
  args: string[],
  {
    cwd,
    env,
    trustedPythonPath,
    timeoutMs = GIT_INSPECTION_TIMEOUT_MS,
  }: GitWorktreeInspectionOptions,
): Promise<CommandResult> {
  return execute(command, args, {
    cwd,
    env,
    captureLimitBytes: GIT_CAPTURE_LIMIT_BYTES,
    superviseProcessTree: true,
    trustedPythonPath,
    timeoutDescription: "git worktree inspection",
    timeoutMs,
  });
}

export function streamUntrustedOutput(
  source: Pick<Readable, "pause" | "resume">,
  target: {
    write(chunk: string): boolean;
    once(event: "drain", listener: () => void): unknown;
  },
  limitBytes: number,
): {
  write(chunk: Buffer): void;
  end(): void;
} {
  const decoder = new StringDecoder("utf8");
  let atLineStart = true;
  let previousWasCarriageReturn = false;
  let acceptedBytes = 0;
  let truncated = false;
  let waitingForDrain = false;
  let decoderEnded = false;
  const write = (text: string): void => {
    if (text.length === 0) return;
    const output: string[] = [];
    for (const character of text) {
      if (previousWasCarriageReturn && character === "\n") {
        output.push(character);
        previousWasCarriageReturn = false;
        continue;
      }
      previousWasCarriageReturn = false;
      if (atLineStart) {
        output.push("[prek] ");
        atLineStart = false;
      }
      output.push(character);
      if (character === "\r") {
        previousWasCarriageReturn = true;
        atLineStart = true;
      } else if (character === "\n") {
        atLineStart = true;
      }
    }
    if (!target.write(output.join("")) && !waitingForDrain) {
      waitingForDrain = true;
      source.pause();
      target.once("drain", () => {
        waitingForDrain = false;
        source.resume();
      });
    }
  };
  const truncate = (): void => {
    if (truncated) return;
    truncated = true;
    decoderEnded = true;
    write(decoder.end());
    if (!atLineStart) write("\n");
    write(`output truncated after ${limitBytes} bytes\n`);
  };
  return {
    write: (chunk) => {
      const remaining = limitBytes - acceptedBytes;
      if (remaining <= 0) {
        if (chunk.length > 0) truncate();
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      acceptedBytes += accepted.length;
      write(decoder.write(accepted));
      if (accepted.length < chunk.length) truncate();
    },
    end: () => {
      if (!decoderEnded) write(decoder.end());
      if (!atLineStart) write("\n");
    },
  };
}

export const executeCommand: Execute = async (command, args, options) =>
  await new Promise<CommandResult>((finish, reject) => {
    const useProcessGroup = process.platform === "linux";
    if (options.superviseProcessTree && !useProcessGroup) {
      reject(new Error("secure hook process cleanup requires Linux"));
      return;
    }
    const supervised = options.superviseProcessTree === true;
    if (
      supervised &&
      (!options.trustedPythonPath || !isAbsolute(options.trustedPythonPath))
    ) {
      reject(
        new Error("secure hook supervision requires a pinned Python path"),
      );
      return;
    }
    const spawnedCommand = supervised ? options.trustedPythonPath! : command;
    const spawnedArgs = supervised
      ? [
          "-I",
          "-c",
          HOOK_SUPERVISOR_SCRIPT,
          String((options.timeoutMs ?? 0) / 1000),
          command,
          ...args,
        ]
      : args;
    const child = spawn(spawnedCommand, spawnedArgs, {
      cwd: options.cwd,
      env: options.env,
      detached: useProcessGroup,
      stdio: supervised
        ? ["ignore", "pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let captureOverflow = false;
    let forceKill: NodeJS.Timeout | undefined;
    const protocol: Buffer[] = [];
    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(useProcessGroup ? -child.pid : child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const streamedStdout = options.streamUntrustedOutput
      ? streamUntrustedOutput(
          child.stdout!,
          process.stdout,
          options.streamLimitBytes ?? 1048576,
        )
      : undefined;
    const streamedStderr = options.streamUntrustedOutput
      ? streamUntrustedOutput(
          child.stderr!,
          process.stderr,
          options.streamLimitBytes ?? 1048576,
        )
      : undefined;
    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      const limit = options.captureLimitBytes;
      if (
        limit !== undefined &&
        (captureOverflow || chunk.byteLength > limit - capturedBytes)
      ) {
        if (!captureOverflow) {
          captureOverflow = true;
          terminate("SIGTERM");
          if (!supervised) {
            forceKill = setTimeout(() => terminate("SIGKILL"), 2000);
            forceKill.unref();
          }
        }
        return;
      }
      capturedBytes += chunk.byteLength;
      chunks.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      if (streamedStdout) streamedStdout.write(chunk);
      else capture(stdout, chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (streamedStderr) streamedStderr.write(chunk);
      else capture(stderr, chunk);
    });
    let timedOut = false;
    const timeoutError = (): Error =>
      new Error(
        `${options.timeoutDescription ?? "prek pass"} timed out after ${Math.ceil((options.timeoutMs ?? 0) / 1000)} seconds; terminated ${options.timeoutDescription ? "process" : "hook process"}${supervised || useProcessGroup ? " tree" : ""}`,
      );
    const timeout =
      options.timeoutMs === undefined || supervised
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate("SIGTERM");
            forceKill = setTimeout(() => {
              terminate("SIGKILL");
              reject(timeoutError());
            }, 2000);
          }, options.timeoutMs);
    timeout?.unref();
    if (supervised) {
      const protocolStream = child.stdio[3];
      if (protocolStream && "on" in protocolStream) {
        protocolStream.on("data", (chunk: Buffer) => {
          if (Buffer.concat(protocol).byteLength + chunk.byteLength <= 4096) {
            protocol.push(chunk);
          }
        });
      }
    }
    const forwardedSignals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
    const signalHandlers = new Map<NodeJS.Signals, () => void>(
      forwardedSignals.map((signal) => [signal, () => terminate(signal)]),
    );
    if (supervised) {
      for (const signal of forwardedSignals) {
        process.on(signal, signalHandlers.get(signal)!);
      }
    }
    const removeSignalHandlers = (): void => {
      if (!supervised) return;
      for (const signal of forwardedSignals) {
        process.off(signal, signalHandlers.get(signal)!);
      }
    };
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      removeSignalHandlers();
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      streamedStdout?.end();
      streamedStderr?.end();
      removeSignalHandlers();
      if (timedOut) {
        if (useProcessGroup) return;
        if (forceKill) clearTimeout(forceKill);
        reject(timeoutError());
        return;
      }
      if (captureOverflow) {
        reject(
          new Error(
            `command output exceeded capture limit of ${options.captureLimitBytes} bytes`,
          ),
        );
        return;
      }
      if (forceKill) clearTimeout(forceKill);
      const complete = async (): Promise<void> => {
        if (supervised) {
          const records = Buffer.concat(protocol).toString("ascii").split("\n");
          if (!records.includes("READY")) {
            throw new Error(
              "hook supervisor failed to establish the Linux subreaper boundary",
            );
          }
          if (!records.includes("NON_DUMPABLE")) {
            throw new Error(
              "hook supervisor failed to protect its protocol channel",
            );
          }
          if (records.includes("CLEANUP_FAILED")) {
            throw new Error(
              "hook supervisor could not prove that all hook descendants exited",
            );
          }
          if (records.includes("SPAWN_FAILED")) {
            throw new Error("hook supervisor could not start prek");
          }
          if (records.includes("CLEAN timeout")) throw timeoutError();
          if (records.includes("CLEAN signal")) {
            throw new Error("prek pass interrupted after hook process cleanup");
          }
          if (!records.includes("CLEAN normal")) {
            throw new Error(
              "hook supervisor exited without proving descendant cleanup",
            );
          }
        }
        finish({
          exitCode: exitCode ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      };
      void complete().catch(reject);
    });
  });
