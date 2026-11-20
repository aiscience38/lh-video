import fs from "node:fs/promises";
import path from "node:path";

/** errno values that mean "this account may not create symlinks", not "the test is broken". */
const UNSUPPORTED = new Set(["EPERM", "EACCES", "UNKNOWN", "ENOTSUP"]);

let cached;

/**
 * Windows only grants CreateSymbolicLink to elevated accounts or Developer Mode, and an unprivileged
 * account gets EPERM. Probe fs.symlink once inside a test-owned temp directory so symlink assertions
 * can be reported as skipped with the real reason instead of failing the gate.
 *
 * Returns null when symlinks work, otherwise a message naming the missing privilege.
 */
export async function symlinkUnavailableReason(directory) {
    if (cached !== undefined) return cached;
    const target = path.join(directory, ".symlink-probe-target");
    const link = path.join(directory, ".symlink-probe-link");
    try {
        await fs.writeFile(target, "");
        await fs.symlink(target, link);
        cached = null;
    } catch (error) {
        if (!UNSUPPORTED.has(error.code)) throw error;
        cached = `symlinks unavailable: fs.symlink(file) failed with ${error.code}; this account lacks symlink privilege (on Windows: SeCreateSymbolicLinkPrivilege — enable Developer Mode or run the tests elevated)`;
    } finally {
        await fs.rm(link, { force: true });
        await fs.rm(target, { force: true });
    }
    return cached;
}
