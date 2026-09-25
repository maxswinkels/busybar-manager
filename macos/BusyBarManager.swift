import AppKit
import Darwin
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private enum ManagerState {
    case starting
    case running
    case retrying(seconds: Int)
  }

  private var statusItem: NSStatusItem?
  private var dashboardItem: NSMenuItem?
  private var infoItem: NSMenuItem?
  private var restartItem: NSMenuItem?
  private var managerProcess: Process?
  private var restartWorkItem: DispatchWorkItem?
  private var outputHandle: FileHandle?
  private var errorHandle: FileHandle?
  private var signalSources: [DispatchSourceSignal] = []
  private var quitting = false
  private var managerStartedAt: Date?
  private var managerProcessGroup: pid_t?
  private var restartRequested = false
  private var restartDelay = AppDelegate.minimumRestartDelay
  private var state: ManagerState = .starting

  // launchd used to supervise Node itself and throttled respawns to its 10s
  // minimum runtime. Supervising from here means owning that throttle: without
  // it a Node that can never start (its port already taken by a container, say)
  // respawns once a second for as long as the Mac is on.
  private static let minimumRestartDelay: TimeInterval = 1
  private static let maximumRestartDelay: TimeInterval = 60
  private static let healthyRuntime: TimeInterval = 30
  private static let defaultListenPort = 8321
  // The wordmark is four times wider than it is tall, so it is sized by height.
  private static let statusIconHeight: CGFloat = 14

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

  // Mirrors how server.js resolves its config, so the dashboard link keeps
  // working after the port is changed there.
  private var configURL: URL? {
    let environment = ProcessInfo.processInfo.environment
    if let path = environment["BUSYBAR_MANAGER_CONFIG"], !path.isEmpty {
      return URL(fileURLWithPath: path)
    }
    return projectDirectory?.appendingPathComponent("config.json")
  }

  private var dashboardURL: URL? {
    var port = Self.defaultListenPort
    if let raw = ProcessInfo.processInfo.environment["PORT"], let value = Int(raw), value > 0 {
      port = value
    } else if let configURL,
              let data = try? Data(contentsOf: configURL),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = json["listenPort"] as? Int, value > 0 {
      port = value
    }
    return URL(string: "http://127.0.0.1:\(port)")
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

  // MARK: - Menu

  private func installStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

    let menu = NSMenu()
    menu.delegate = self
    // Without this AppKit decides enablement from the responder chain and
    // overrides the state set below, leaving a dead dashboard link clickable.
    menu.autoenablesItems = false

    let dashboard = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "d")
    dashboard.target = self
    menu.addItem(dashboard)
    menu.addItem(.separator())

    // One line that answers "what is the bar doing?" while healthy, and turns
    // into the failure reason when it is not. There is no idle "Running" label:
    // a state that is always true tells the reader nothing.
    let info = NSMenuItem(title: "Starting\u{2026}", action: nil, keyEquivalent: "")
    info.isEnabled = false
    menu.addItem(info)
    menu.addItem(.separator())

    let restart = NSMenuItem(title: "Restart Manager", action: #selector(restartManager), keyEquivalent: "r")
    restart.target = self
    menu.addItem(restart)

    let logs = NSMenuItem(title: "Open Logs", action: #selector(openLogs), keyEquivalent: "l")
    logs.target = self
    menu.addItem(logs)
    menu.addItem(.separator())

    let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    item.menu = menu
    item.button?.image = Self.statusIcon()
    item.button?.imagePosition = .imageOnly
    if item.button?.image == nil {
      item.button?.title = "BUSY"
    }

    statusItem = item
    dashboardItem = dashboard
    infoItem = info
    restartItem = restart
    apply(state: .starting)
  }

  // The BUSY wordmark, shipped as a vector next to the binary. AppKit renders a
  // template image from its alpha channel alone, so it follows the menu bar in
  // light and dark mode without a second asset.
  private static func statusIcon() -> NSImage? {
    guard let url = Bundle.main.url(forResource: "StatusIcon", withExtension: "svg"),
          let image = NSImage(contentsOf: url), image.size.height > 0 else { return nil }
    let width = (image.size.width / image.size.height * statusIconHeight).rounded()
    image.size = NSSize(width: width, height: statusIconHeight)
    image.isTemplate = true
    image.accessibilityDescription = "BusyBar Manager"
    return image
  }

  func menuWillOpen(_ menu: NSMenu) {
    refreshScreenOwner()
  }

  private func apply(state newState: ManagerState) {
    state = newState
    let running: Bool
    switch newState {
    case .starting:
      infoItem?.title = "Starting\u{2026}"
      running = false
    case .running:
      // Replaced by the real answer as soon as the manager reports one.
      infoItem?.title = "Showing: \u{2026}"
      running = true
      refreshScreenOwner()
    case .retrying(let seconds):
      infoItem?.title = "Stopped, retrying in \(seconds)s"
      running = false
    }

    dashboardItem?.isEnabled = running
    restartItem?.title = running ? "Restart Manager" : "Start Manager Now"
    // A faded wordmark is the only signal a healthy Mac ever needs to show.
    statusItem?.button?.appearsDisabled = !running
    statusItem?.button?.toolTip = "BusyBar Manager: \(infoItem?.title ?? "")"
  }

  // Asked for when the menu opens rather than polled: nothing reads this while
  // the menu is shut.
  private func refreshScreenOwner() {
    guard case .running = state, let base = dashboardURL else { return }
    var request = URLRequest(url: base.appendingPathComponent("api/_manager/state"))
    request.timeoutInterval = 2
    URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
      var owner: String?
      if let data,
         let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let screenOwner = json["screenOwner"] as? [String: Any] {
        owner = screenOwner["applicationName"] as? String ?? screenOwner["slug"] as? String
      }
      DispatchQueue.main.async {
        guard let self, case .running = self.state else { return }
        self.infoItem?.title = owner.map { "Showing: \($0)" } ?? "Nothing on the bar"
        self.statusItem?.button?.toolTip = "BusyBar Manager: \(self.infoItem?.title ?? "")"
      }
    }.resume()
  }

  // MARK: - Actions

  @objc private func openDashboard() {
    guard let dashboardURL else { return }
    NSWorkspace.shared.open(dashboardURL)
  }

  @objc private func openLogs() {
    guard let projectDirectory else { return }
    NSWorkspace.shared.open(projectDirectory.appendingPathComponent("logs/manager.log"))
  }

  @objc private func restartManager() {
    guard !quitting else { return }
    // A restart the user asked for should not inherit a crash loop's penalty.
    restartDelay = Self.minimumRestartDelay

    guard let process = managerProcess, process.isRunning else {
      restartWorkItem?.cancel()
      restartWorkItem = nil
      startManagerIfPossible()
      return
    }

    restartRequested = true
    process.terminate()
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }

  // MARK: - Supervision

  private func installSignalHandlers() {
    for signalNumber in [SIGINT, SIGTERM] {
      Darwin.signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
      source.setEventHandler { NSApp.terminate(nil) }
      source.resume()
      signalSources.append(source)
    }
  }

  private func startManagerIfPossible() {
    guard let projectDirectory, let nodeExecutable, let pythonExecutable else { return }
    startManager(projectDirectory: projectDirectory, nodeExecutable: nodeExecutable, pythonExecutable: pythonExecutable)
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
      apply(state: .running)
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
    let reason = restartRequested
      ? "restart requested from the menu"
      : "busybar-manager exited with status \(process.terminationStatus)"
    restartRequested = false
    scheduleRestart(reason: reason)
  }

  private func scheduleRestart(reason: String) {
    guard !quitting, restartWorkItem == nil else { return }
    let delay = restartDelay
    restartDelay = min(restartDelay * 2, Self.maximumRestartDelay)
    logLauncherError("\(reason); restarting in \(Int(delay))s")
    apply(state: .retrying(seconds: Int(delay)))
    let workItem = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.restartWorkItem = nil
      self.startManagerIfPossible()
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

  // MARK: - Logging

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
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
