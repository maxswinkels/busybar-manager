import AppKit
import Darwin
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem?
  private var managerProcess: Process?
  private var restartWorkItem: DispatchWorkItem?
  private var outputHandle: FileHandle?
  private var errorHandle: FileHandle?
  private var signalSources: [DispatchSourceSignal] = []
  private var quitting = false
  private var statusMenuItem: NSMenuItem?
  private var managerStartedAt: Date?
  private var managerProcessGroup: pid_t?
  private var restartDelay = AppDelegate.minimumRestartDelay

  // launchd used to supervise Node itself and throttled respawns to its 10s
  // minimum runtime. Supervising from here means owning that throttle: without
  // it a Node that can never start (its port already taken by a container, say)
  // respawns once a second for as long as the Mac is on.
  private static let minimumRestartDelay: TimeInterval = 1
  private static let maximumRestartDelay: TimeInterval = 60
  private static let healthyRuntime: TimeInterval = 30

  private var projectDirectory: URL? {
    guard let path = Bundle.main.object(forInfoDictionaryKey: "BusyBarProjectDirectory") as? String,
          !path.isEmpty else { return nil }
    return URL(fileURLWithPath: path, isDirectory: true)
  }

  private var nodeExecutable: URL? {
    guard let path = Bundle.main.object(forInfoDictionaryKey: "BusyBarNodeExecutable") as? String,
          !path.isEmpty else { return nil }
    return URL(fileURLWithPath: path)
  }

  private var pythonExecutable: URL? {
    guard let path = Bundle.main.object(forInfoDictionaryKey: "BusyBarPythonExecutable") as? String,
          !path.isEmpty else { return nil }
    return URL(fileURLWithPath: path)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    installStatusItem()
    installSignalHandlers()

    guard let projectDirectory, let nodeExecutable, let pythonExecutable,
          FileManager.default.isExecutableFile(atPath: nodeExecutable.path),
          FileManager.default.isExecutableFile(atPath: pythonExecutable.path),
          FileManager.default.fileExists(atPath: projectDirectory.appendingPathComponent("server.js").path) else {
      showFatalError("The configured Node/Python executable or busybar-manager checkout could not be found. Run scripts/install.sh again.")
      return
    }

    startManager(projectDirectory: projectDirectory, nodeExecutable: nodeExecutable, pythonExecutable: pythonExecutable)
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard !quitting else { return .terminateLater }
    quitting = true
    restartWorkItem?.cancel()

    let group = managerProcessGroup
    managerProcessGroup = nil

    guard let process = managerProcess, process.isRunning else {
      Self.killGroup(group)
      return .terminateNow
    }

    process.terminate()
    DispatchQueue.global(qos: .utility).async {
      let deadline = Date().addingTimeInterval(6)
      while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.1)
      }
      if process.isRunning {
        if !Self.killGroup(group) {
          Darwin.kill(process.processIdentifier, SIGKILL)
        }
      }
      process.waitUntilExit()
      // The direct child is a version-manager shim; sweep the server and the
      // apps it spawned rather than leaving them orphaned.
      _ = Self.killGroup(group)
      DispatchQueue.main.async {
        sender.reply(toApplicationShouldTerminate: true)
      }
    }
    return .terminateLater
  }

  private func installStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

    let menu = NSMenu()
    let state = NSMenuItem(title: "Starting\u{2026}", action: nil, keyEquivalent: "")
    state.isEnabled = false
    menu.addItem(state)
    menu.addItem(.separator())
    let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)
    item.menu = menu

    statusItem = item
    statusMenuItem = state
    showStatus("Starting\u{2026}", healthy: true)
  }

  // A manager that never starts is otherwise invisible: the menu bar is the only
  // place that failure surfaces without opening a log file.
  private func showStatus(_ text: String, healthy: Bool) {
    statusMenuItem?.title = text
    guard let button = statusItem?.button else { return }
    let symbol = healthy ? "display" : "display.trianglebadge.exclamationmark"
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "BusyBar Manager")
      ?? NSImage(systemSymbolName: "display", accessibilityDescription: "BusyBar Manager")
    if let image {
      image.isTemplate = true
      button.image = image
      button.title = ""
    } else {
      button.image = nil
      button.title = healthy ? "B" : "B!"
    }
    button.toolTip = "BusyBar Manager: \(text)"
  }

  private func installSignalHandlers() {
    for signalNumber in [SIGINT, SIGTERM] {
      Darwin.signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
      source.setEventHandler { NSApp.terminate(nil) }
      source.resume()
      signalSources.append(source)
    }
  }

  private func startManager(projectDirectory: URL, nodeExecutable: URL, pythonExecutable: URL) {
    guard !quitting, managerProcess == nil else { return }

    do {
      let logsDirectory = projectDirectory.appendingPathComponent("logs", isDirectory: true)
      try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
      outputHandle = try logHandle(at: logsDirectory.appendingPathComponent("manager.log"))
      errorHandle = try logHandle(at: logsDirectory.appendingPathComponent("manager.err.log"))

      let process = Process()
      process.executableURL = nodeExecutable
      process.arguments = [projectDirectory.appendingPathComponent("server.js").path]
      process.currentDirectoryURL = projectDirectory
      process.standardOutput = outputHandle
      process.standardError = errorHandle

      var environment = ProcessInfo.processInfo.environment
      let nodeDirectory = nodeExecutable.deletingLastPathComponent().path
      let pythonDirectory = pythonExecutable.deletingLastPathComponent().path
      environment["PATH"] = [nodeDirectory, pythonDirectory, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        .joined(separator: ":")
      environment["BUSYBAR_PYTHON"] = pythonExecutable.path
      process.environment = environment
      process.terminationHandler = { [weak self] terminatedProcess in
        DispatchQueue.main.async {
          self?.managerDidTerminate(terminatedProcess)
        }
      }

      managerProcess = process
      try process.run()
      managerStartedAt = Date()
      managerProcessGroup = Self.processGroup(of: process)
      showStatus("Running", healthy: true)
    } catch {
      managerProcess = nil
      closeLogHandles()
      scheduleRestart(reason: "could not start busybar-manager: \(error)")
    }
  }

  private func managerDidTerminate(_ process: Process) {
    guard managerProcess === process else { return }
    managerProcess = nil
    closeLogHandles()
    let ranFor = managerStartedAt.map { Date().timeIntervalSince($0) } ?? 0
    managerStartedAt = nil
    // A shim killed outright leaves the real server running and still bound to
    // the port, which would make every replacement fail to bind. Sweep the old
    // process group before starting a new one.
    _ = Self.killGroup(managerProcessGroup)
    managerProcessGroup = nil
    guard !quitting else { return }
    if ranFor >= Self.healthyRuntime {
      restartDelay = Self.minimumRestartDelay
    }
    scheduleRestart(reason: "busybar-manager exited with status \(process.terminationStatus)")
  }

  private func scheduleRestart(reason: String) {
    guard !quitting, restartWorkItem == nil else { return }
    let delay = restartDelay
    restartDelay = min(restartDelay * 2, Self.maximumRestartDelay)
    logLauncherError("\(reason); restarting in \(Int(delay))s")
    showStatus("Stopped, retrying in \(Int(delay))s", healthy: false)
    let workItem = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.restartWorkItem = nil
      guard let projectDirectory = self.projectDirectory,
            let nodeExecutable = self.nodeExecutable,
            let pythonExecutable = self.pythonExecutable else { return }
      self.startManager(
        projectDirectory: projectDirectory,
        nodeExecutable: nodeExecutable,
        pythonExecutable: pythonExecutable
      )
    }
    restartWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: workItem)
  }

  // Node is usually reached through a version-manager shim (Volta, asdf, nvm),
  // so the real server is a grandchild and the apps it spawns sit below that.
  // Process gives the child its own process group, so signalling the group takes
  // the whole tree. Only a group the child leads is safe to signal: anything else
  // could be this app's own group.
  private static func processGroup(of process: Process) -> pid_t? {
    let pid = process.processIdentifier
    return getpgid(pid) == pid ? pid : nil
  }

  @discardableResult
  private static func killGroup(_ group: pid_t?) -> Bool {
    guard let group, group > 1 else { return false }
    Darwin.kill(-group, SIGKILL)
    return true
  }

  private func logHandle(at url: URL) throws -> FileHandle {
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    let handle = try FileHandle(forWritingTo: url)
    try handle.seekToEnd()
    return handle
  }

  private func closeLogHandles() {
    try? outputHandle?.close()
    try? errorHandle?.close()
    outputHandle = nil
    errorHandle = nil
  }

  private func logLauncherError(_ message: String) {
    guard let projectDirectory else { return }
    let url = projectDirectory.appendingPathComponent("logs/manager.err.log")
    let line = "[\(ISO8601DateFormatter().string(from: Date()))] [launcher] \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    if !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: data)
      return
    }
    guard let handle = try? FileHandle(forWritingTo: url) else { return }
    _ = try? handle.seekToEnd()
    _ = try? handle.write(contentsOf: data)
    _ = try? handle.close()
  }

  private func showFatalError(_ message: String) {
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "BusyBar Manager could not start"
    alert.informativeText = message
    alert.addButton(withTitle: "Quit")
    alert.runModal()
    NSApp.terminate(nil)
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
