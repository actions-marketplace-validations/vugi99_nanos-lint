import envPaths from "env-paths";

/**
 * System paths resolved for nanos-lint using cross-platform conventions
 * provided by env-paths (XDG on Linux, %LOCALAPPDATA%/%APPDATA% on Windows, ~/Library on macOS).
 */
export const systemPaths = envPaths("nanos-lint", { suffix: "" });

export default systemPaths;

