// Can — the app's main executable and supervisor.
//
// launchd starts THIS process (it is Can.app's CFBundleExecutable);
// it runs Can's Node agent as a child and restarts it if it ever
// exits. Sitting at the root of the process tree is what makes macOS
// attribute the whole tree's privacy identity (Accessibility, Screen
// Recording) to Can.app: the permission lists carry one entry —
// "Can", with Can's icon — instead of the Node runtime's.
//
// The bundle's contents never change after installation (the agent
// script and the desktop engine live in ~/can-agent, Can's data
// directory), so the code identity behind those grants stays stable
// across agent and engine updates.
//
// Paths can be overridden by environment (set in the LaunchAgent
// plist): CAN_NODE, CAN_AGENT_JS, CAN_HOME.

import Foundation

let env = ProcessInfo.processInfo.environment
let nodePath = env["CAN_NODE"] ?? "/Users/cyou/node/bin/node"
let agentPath = env["CAN_AGENT_JS"] ?? "/Users/cyou/can-agent/agent.js"
let homePath = env["CAN_HOME"] ?? "/Users/cyou/can-agent"

var child: Process? = nil
var stopping = false
var signalSources: [DispatchSourceSignal] = []

func stopChild() {
    if let c = child, c.isRunning { c.terminate() }
}

for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler {
        stopping = true
        stopChild()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { exit(0) }
    }
    src.resume()
    signalSources.append(src)
}

DispatchQueue.global().async {
    while !stopping {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath)
        p.arguments = [agentPath]
        p.currentDirectoryURL = URL(fileURLWithPath: homePath)
        child = p
        do {
            try p.run()
        } catch {
            FileHandle.standardError.write(
                "Can supervisor: cannot launch agent: \(error)\n".data(using: .utf8)!)
            Thread.sleep(forTimeInterval: 2.0)
            continue
        }
        p.waitUntilExit()
        if stopping { break }
        Thread.sleep(forTimeInterval: 1.0)
    }
    exit(0)
}

dispatchMain()
