import Darwin
import Foundation

struct HelperConfig {
    let workingDirectory: String
    let command: [String]
}

func usage() -> Never {
    FileHandle.standardError.write(Data("""
    Usage: ForgeAgentPowerHelper --working-directory <path> -- <command> [args...]
    Holds a native macOS idle-system-sleep assertion while the child command runs.

    """.utf8))
    exit(64)
}

func parseArgs(_ args: [String]) -> HelperConfig {
    var workingDirectory: String?
    var index = 0

    while index < args.count {
        let arg = args[index]
        if arg == "--" {
            let command = Array(args.dropFirst(index + 1))
            guard !command.isEmpty else { usage() }
            return HelperConfig(
                workingDirectory: workingDirectory ?? FileManager.default.currentDirectoryPath,
                command: command
            )
        }

        if arg == "--working-directory" {
            guard index + 1 < args.count else { usage() }
            workingDirectory = args[index + 1]
            index += 2
            continue
        }

        usage()
    }

    usage()
}

nonisolated(unsafe) var childPid: pid_t = -1

func forwardSignal(_ signalNumber: Int32) {
    if childPid > 0 {
        kill(-childPid, signalNumber)
    }
}

let rawArgs = Array(CommandLine.arguments.dropFirst())
if rawArgs == ["--version"] {
    print("ForgeAgentPowerHelper 0.1.0")
    exit(0)
}

let config = parseArgs(rawArgs)
let activity = ProcessInfo.processInfo.beginActivity(
    options: [.idleSystemSleepDisabled],
    reason: "ForgeAgent remote access keeps Core online while the display may sleep."
)

signal(SIGTERM, forwardSignal)
signal(SIGINT, forwardSignal)
signal(SIGHUP, forwardSignal)

if chdir(config.workingDirectory) != 0 {
    let message = String(cString: strerror(errno))
    ProcessInfo.processInfo.endActivity(activity)
    FileHandle.standardError.write(Data("ForgeAgentPowerHelper failed to enter working directory: \(message)\n".utf8))
    exit(1)
}

var spawnAttributes: posix_spawnattr_t?
posix_spawnattr_init(&spawnAttributes)
var spawnFlags = Int16(POSIX_SPAWN_SETPGROUP)
posix_spawnattr_setflags(&spawnAttributes, spawnFlags)
posix_spawnattr_setpgroup(&spawnAttributes, 0)

let argv = config.command.map { strdup($0) } + [nil]
let envp = ProcessInfo.processInfo.environment.map { key, value in
    strdup("\(key)=\(value)")
} + [nil]

let spawnResult = posix_spawn(&childPid, config.command[0], nil, &spawnAttributes, argv, envp)
posix_spawnattr_destroy(&spawnAttributes)

for pointer in argv where pointer != nil {
    free(pointer)
}
for pointer in envp where pointer != nil {
    free(pointer)
}

if spawnResult != 0 {
    let message = String(cString: strerror(spawnResult))
    ProcessInfo.processInfo.endActivity(activity)
    FileHandle.standardError.write(Data("ForgeAgentPowerHelper failed to start Core: \(message)\n".utf8))
    exit(1)
}

var status: Int32 = 0
while waitpid(childPid, &status, 0) == -1 {
    if errno == EINTR {
        continue
    }
    let message = String(cString: strerror(errno))
    ProcessInfo.processInfo.endActivity(activity)
    FileHandle.standardError.write(Data("ForgeAgentPowerHelper failed while waiting for Core: \(message)\n".utf8))
    exit(1)
}

ProcessInfo.processInfo.endActivity(activity)
let signalNumber = status & 0x7f
if signalNumber == 0 {
    exit((status >> 8) & 0xff)
}
exit(128 + signalNumber)
