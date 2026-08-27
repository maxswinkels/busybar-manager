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

    guard let process = managerProcess, process.isRunning else { return .terminateNow }

    process.terminate()
    DispatchQueue.global(qos: .utility).async {
      let deadline = Date().addingTimeInterval(6)
      while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.1)
      }
      if process.isRunning {
        Darwin.kill(process.processIdentifier, SIGKILL)
      }
      process.waitUntilExit()
      DispatchQueue.main.async {
        sender.reply(toApplicationShouldTerminate: true)
      }
    }
    return .terminateLater
  }

  private func installStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = item.button {
      if let image = NSImage(systemSymbolName: "display", accessibilityDescription: "BusyBar Manager") {
        image.isTemplate = true
        button.image = image
      } else {
        button.title = "B"
      }
      button.toolTip = "BusyBar Manager"
    }

    let menu = NSMenu()
    let quitItem = NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)
    item.menu = menu
    statusItem = item
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
    } catch {
      managerProcess = nil
      closeLogHandles()
      logLauncherError("Could not start busybar-manager: \(error)")
      scheduleRestart()
    }
  }

  private func managerDidTerminate(_ process: Process) {
    guard managerProcess === process else { return }
    managerProcess = nil
    closeLogHandles()
    if !quitting {
      logLauncherError("busybar-manager exited with status \(process.terminationStatus); restarting")
      scheduleRestart()
    }
  }

  private func scheduleRestart() {
    guard !quitting, restartWorkItem == nil else { return }
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
    DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: workItem)
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
