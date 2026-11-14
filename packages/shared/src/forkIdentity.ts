/** Desktop tester boundaries; internal package names and mobile identities are unchanged. */
export const FORK_DESKTOP = {
  productName: "T3 Code Voice",
  packageName: "t3code-voice",
  appId: "io.github.notrllyrn.t3codevoice",
  developmentAppId: "io.github.notrllyrn.t3codevoice.dev",
  profileName: "t3code-voice",
  developmentProfileName: "t3code-voice-dev",
  homeDirectoryName: ".t3code-voice",
  homeEnvironmentVariable: "T3CODE_VOICE_HOME",
  scheme: "t3code-voice",
  developmentScheme: "t3code-voice-dev",
  manualUpdatesOnly: true,
  manualUpdatesReason: "Manual updates only for T3 Code Voice testers.",
  releasesUrl: "https://github.com/NotRllyRn/t3code-voice/releases",
} as const;

export const forkDesktopScheme = (isDevelopment: boolean): string =>
  isDevelopment ? FORK_DESKTOP.developmentScheme : FORK_DESKTOP.scheme;
