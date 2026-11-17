import * as cache from "@actions/cache";
import * as core from "@actions/core";
import {
  cacheDependencyGlob,
  cacheLocalPath,
  cacheSuffix,
  pruneCache,
  restoreKeysFallback,
  pythonVersion as pythonVersionInput,
  workingDirectory,
} from "../utils/inputs";
import { getArch, getPlatform } from "../utils/platforms";
import { hashFiles } from "../hash/hash-files";
import * as exec from "@actions/exec";

export const STATE_CACHE_KEY = "cache-key";
export const STATE_CACHE_MATCHED_KEY = "cache-matched-key";
const CACHE_VERSION = "1";

export async function restoreCache(uvVersion: string): Promise<void> {
  const { cacheKey, restoreKeys } = await computeKeys(uvVersion);

  let matchedKey: string | undefined;
  core.info(
    `Trying to restore uv cache from GitHub Actions cache with key: ${cacheKey}`,
  );
  try {
    matchedKey = await cache.restoreCache(
      [cacheLocalPath],
      cacheKey,
      restoreKeys,
    );
  } catch (err) {
    const message = (err as Error).message;
    core.warning(message);
    core.setOutput("cache-hit", false);
    return;
  }

  core.saveState(STATE_CACHE_KEY, cacheKey);

  handleMatchResult(matchedKey, cacheKey);
}

async function computeKeys(uvVersion: string): Promise<{
  cacheKey: string;
  restoreKeys: string[];
}> {
  let cacheDependencyPathHash = "-";
  if (cacheDependencyGlob !== "") {
    core.info(
      `Searching files using cache dependency glob: ${cacheDependencyGlob.split("\n").join(",")}`,
    );
    cacheDependencyPathHash += await hashFiles(cacheDependencyGlob, true);
    if (cacheDependencyPathHash === "-") {
      core.warning(
        `No file matched to [${cacheDependencyGlob.split("\n").join(",")}]. The cache will never get invalidated. Make sure you have checked out the target repository and configured the cache-dependency-glob input correctly.`,
      );
    }
  }
  if (cacheDependencyPathHash === "-") {
    cacheDependencyPathHash = "-no-dependency-glob";
  }
  const suffix = cacheSuffix ? `-${cacheSuffix}` : "";
  const pythonVersion = await getPythonVersion();
  const platform = await getPlatform();
  const pruned = pruneCache ? "-pruned" : "";
  // uv cannot reuse cache entries saved by another uv version, so the version is part of the key and of the
  // fallback prefix. Without it a new uv release restores the old entry on an exact hit, ignores it, and never saves a new one.
  const keyBase = `setup-uv-${CACHE_VERSION}-${getArch()}-${platform}-uv${uvVersion}-${pythonVersion}${pruned}`;
  const keyPrefix = `${keyBase}-`;
  const cacheKey = `${keyBase}${cacheDependencyPathHash}${suffix}`;
  // The uv cache is content addressed, so an entry saved for an older lockfile still holds most of the
  // wheels. Without this, any change to uv.lock or pyproject.toml misses the cache and downloads everything.
  return { cacheKey, restoreKeys: restoreKeysFallback ? [keyPrefix] : [] };
}

async function getPythonVersion(): Promise<string> {
  if (pythonVersionInput !== "") {
    return pythonVersionInput;
  }

  let output = "";
  const options: exec.ExecOptions = {
    silent: !core.isDebug(),
    listeners: {
      stdout: (data: Buffer) => {
        output += data.toString();
      },
    },
  };

  try {
    const execArgs = ["python", "find", "--directory", workingDirectory];
    await exec.exec("uv", execArgs, options);
    const pythonPath = output.trim();

    output = "";
    await exec.exec(pythonPath, ["--version"], options);
    // output is like "Python 3.8.10"
    return output.split(" ")[1].trim();
  } catch (error) {
    const err = error as Error;
    core.debug(`Failed to get python version from uv. Error: ${err.message}`);
    return "unknown";
  }
}

function handleMatchResult(
  matchedKey: string | undefined,
  primaryKey: string,
): void {
  if (!matchedKey) {
    core.info(`No GitHub Actions cache found for key: ${primaryKey}`);
    core.setOutput("cache-hit", false);
    return;
  }

  core.saveState(STATE_CACHE_MATCHED_KEY, matchedKey);
  core.info(
    `uv cache restored from GitHub Actions cache with key: ${matchedKey}`,
  );
  // cache-hit stays an exact-match signal; a restore-keys match restores files but is not a hit.
  core.setOutput("cache-hit", matchedKey === primaryKey);
}
