/**
 * Lets `node --test` load app modules the way Next's bundler does: the "@/..." alias,
 * extensionless and directory imports, and packages like next/server that ship no
 * exports map and so need an explicit ".js" under plain Node.
 */
const SRC = new URL("../src/", import.meta.url);
const SUFFIXES = [".ts", "/index.ts", ".js"];
const RETRYABLE = new Set(["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"]);

export async function resolve(specifier, context, nextResolve) {
  const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier;
  try {
    return await nextResolve(target, context);
  } catch (error) {
    if (!RETRYABLE.has(error?.code) || /\.[cm]?[jt]sx?$/.test(target)) throw error;
    for (const suffix of SUFFIXES) {
      try {
        return await nextResolve(target + suffix, context);
      } catch {
        // try the next suffix
      }
    }
    throw error;
  }
}
