import AppKit
import Foundation
import SwiftUI

struct ThreadSummary: Decodable {
    let ok: Bool?
    let threads: [ThreadRow]?
}

struct ThreadRow: Decodable {
    let title: String?
    let name: String?
}

enum ServiceState: Equatable {
    case notInstalled
    case unloaded
    case running
    case stopped
    case unknown(String)

    var displayName: String {
        switch self {
        case .notInstalled: return "未安装"
        case .unloaded: return "未加载"
        case .running: return "运行中"
        case .stopped: return "已停止"
        case .unknown(let value): return value.isEmpty ? "未知" : value
        }
    }
}

@MainActor
final class ServiceManager: ObservableObject {
    @Published var state: ServiceState = .unloaded
    @Published var healthOK = false
    @Published var pid: String?
    @Published var port: Int
    @Published var threadCount: Int?
    @Published var latestThreadTitle = "尚未读取线程"
    @Published var logPreview = ""
    @Published var lastUpdated = Date()
    @Published var showAlert = false
    @Published var alertMessage = ""

    let appName: String
    private let label: String
    private let supportDirectoryName: String
    private let defaultPort: Int
    private let fileManager = FileManager.default

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        self.appName = (info["CFBundleDisplayName"] as? String) ?? "Codex Mini"
        self.label = (info["CodexMiniServiceLabel"] as? String) ?? "codex-mini.local"
        self.supportDirectoryName = (info["CodexMiniSupportDirectoryName"] as? String) ?? "Codex Mini"
        self.defaultPort = Int((info["CodexMiniPort"] as? String) ?? "") ?? 8787
        self.port = defaultPort
    }

    private var homeDirectory: URL { fileManager.homeDirectoryForCurrentUser }
    private var installDirectory: URL { homeDirectory.appendingPathComponent("Library/Application Support/\(supportDirectoryName)") }
    private var logsDirectory: URL { installDirectory.appendingPathComponent("logs") }
    private var plistURL: URL { homeDirectory.appendingPathComponent("Library/LaunchAgents/\(label).plist") }
    private var stdoutURL: URL { logsDirectory.appendingPathComponent("launchd.out.log") }
    private var stderrURL: URL { logsDirectory.appendingPathComponent("launchd.err.log") }
    private var embeddedProjectURL: URL { Bundle.main.resourceURL!.appendingPathComponent("CodexMiniProject") }
    private var embeddedNodeURL: URL { Bundle.main.resourceURL!.appendingPathComponent("node/node") }
    private var domain: String { "gui/\(getuid())" }

    var statusColor: Color {
        if healthOK { return .green }
        switch state {
        case .running: return .yellow
        case .stopped, .unloaded, .notInstalled: return .red
        case .unknown: return .orange
        }
    }

    var healthText: String { healthOK ? "HTTP 健康检查正常" : "健康检查不可用" }
    var threadCountText: String { threadCount.map(String.init) ?? "—" }
    var shortInstallDirectory: String { "~/Library/Application Support/\(supportDirectoryName)" }
    var localURLString: String { "http://localhost:\(port)/" }
    var currentEntryURLString: String { localURLString }
    var currentEntryKindText: String { "本机入口" }
    var currentCopyButtonTitle: String { "复制本机链接" }
    var lastUpdatedText: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return "更新于 \(formatter.string(from: lastUpdated))"
    }

    func prepareIfNeeded() async {
        do { try prepareInstallation() }
        catch { present("准备安装包资源失败：\(error.localizedDescription)") }
    }

    func refresh() async {
        readPlistPort()
        let status = await readLaunchStatus()
        state = status.state
        pid = status.pid
        healthOK = await checkHealth()
        await refreshThreads()
        logPreview = readLogPreview()
        lastUpdated = Date()
    }

    func start() async {
        do {
            try prepareInstallation()
            if !launchctlPrintAvailable() {
                _ = try? run("/bin/launchctl", ["bootstrap", domain, plistURL.path])
            }
            _ = try? run("/bin/launchctl", ["kickstart", "-k", "\(domain)/\(label)"])
            try await Task.sleep(nanoseconds: 700_000_000)
            await refresh()
        } catch {
            present("启动服务失败：\(error.localizedDescription)")
        }
    }

    func stop() async {
        _ = try? run("/bin/launchctl", ["bootout", "\(domain)/\(label)"])
        try? await Task.sleep(nanoseconds: 400_000_000)
        await refresh()
    }

    func restart() async {
        await stop()
        try? await Task.sleep(nanoseconds: 400_000_000)
        await start()
    }

    func openWeb() {
        Task {
            if !(await checkHealth()) { await start() }
            guard let url = URL(string: localURLWithToken()) else { return }
            NSWorkspace.shared.open(url)
        }
    }

    func copyLocalLink() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(localURLWithToken(), forType: .string)
        present("已复制本机链接")
    }

    func openLogs() { NSWorkspace.shared.open(logsDirectory) }
    func openInstallDirectory() { NSWorkspace.shared.open(installDirectory) }

    private func prepareInstallation() throws {
        guard fileManager.fileExists(atPath: embeddedProjectURL.appendingPathComponent("server.js").path) else {
            throw NSError(domain: "CodexMini", code: 1, userInfo: [NSLocalizedDescriptionKey: "App 内没有找到内嵌服务文件"])
        }
        try fileManager.createDirectory(at: installDirectory, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
        _ = try run("/usr/bin/ditto", [embeddedProjectURL.path, installDirectory.path])
        _ = try? run("/bin/chmod", ["+x", installDirectory.appendingPathComponent("bin/codex-window-point").path])
        let token = readTokenFromPlist() ?? generateToken()
        try writeLaunchAgent(token: token)
    }

    private func writeLaunchAgent(token: String) throws {
        let launchAgents = plistURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: launchAgents, withIntermediateDirectories: true)
        let nodePath = embeddedNodeURL.path
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict>
          <key>Label</key><string>\(label)</string>
          <key>WorkingDirectory</key><string>\(installDirectory.path.xmlEscaped)</string>
          <key>EnvironmentVariables</key><dict>
            <key>MOBILE_TYPER_TOKEN</key><string>\(token.xmlEscaped)</string>
            <key>PORT</key><string>\(String(defaultPort))</string>
            <key>CODEX_MINI_APP_NAME</key><string>\(appName.xmlEscaped)</string>
            <key>CODEX_MINI_STATE_DIR</key><string>\(homeDirectory.appendingPathComponent(".codex-mini").path.xmlEscaped)</string>
          </dict>
          <key>ProgramArguments</key><array><string>\(nodePath.xmlEscaped)</string><string>\(installDirectory.appendingPathComponent("server.js").path.xmlEscaped)</string></array>
          <key>RunAtLoad</key><true/>
          <key>KeepAlive</key><true/>
          <key>StandardOutPath</key><string>\(stdoutURL.path.xmlEscaped)</string>
          <key>StandardErrorPath</key><string>\(stderrURL.path.xmlEscaped)</string>
        </dict></plist>
        """
        try xml.write(to: plistURL, atomically: true, encoding: .utf8)
    }

    private func readPlistPort() {
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let env = plist["EnvironmentVariables"] as? [String: Any],
              let value = env["PORT"] as? String,
              let parsed = Int(value) else { port = defaultPort; return }
        port = parsed
    }

    private func readTokenFromPlist() -> String? {
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let env = plist["EnvironmentVariables"] as? [String: Any] else { return nil }
        return env["MOBILE_TYPER_TOKEN"] as? String
    }

    private func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 18)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func localURLWithToken() -> String {
        let token = readTokenFromPlist() ?? generateToken()
        return "http://localhost:\(port)/?token=\(token)"
    }

    private func checkHealth() async -> Bool {
        guard let token = readTokenFromPlist(),
              let url = URL(string: "http://127.0.0.1:\(port)/codex/health?token=\(token)") else { return false }
        do {
            let (_, response) = try await URLSession.shared.data(from: url)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch { return false }
    }

    private func refreshThreads() async {
        guard let token = readTokenFromPlist(),
              let url = URL(string: "http://127.0.0.1:\(port)/codex/threads?limit=20&token=\(token)") else { return }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let decoded = try JSONDecoder().decode(ThreadSummary.self, from: data)
            let rows = decoded.threads ?? []
            threadCount = rows.count
            latestThreadTitle = rows.first?.title ?? rows.first?.name ?? "暂无线程"
        } catch {}
    }

    private func readLaunchStatus() async -> (state: ServiceState, pid: String?) {
        if !fileManager.fileExists(atPath: plistURL.path) { return (.notInstalled, nil) }
        guard let output = try? run("/bin/launchctl", ["print", "\(domain)/\(label)"]) else { return (.unloaded, nil) }
        if let pid = output.firstMatch(#"pid = (\d+)"#) { return (.running, pid) }
        if output.contains("state = running") { return (.running, nil) }
        if output.contains("state = exited") { return (.stopped, nil) }
        return (.unknown("已加载"), nil)
    }

    private func launchctlPrintAvailable() -> Bool {
        (try? run("/bin/launchctl", ["print", "\(domain)/\(label)"])) != nil
    }

    private func readLogPreview() -> String {
        let paths = [stderrURL, stdoutURL]
        for url in paths {
            if let text = try? String(contentsOf: url, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return String(text.suffix(1200))
            }
        }
        return ""
    }

    private func run(_ launchPath: String, _ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments
        let pipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = pipe
        process.standardError = errorPipe
        try process.run()
        process.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let errorText = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if process.terminationStatus != 0 {
            throw NSError(domain: "CodexMiniProcess", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: errorText.isEmpty ? "命令失败：\(launchPath)" : errorText])
        }
        return output
    }

    private func present(_ message: String) {
        alertMessage = message
        showAlert = true
    }
}

private extension String {
    var xmlEscaped: String {
        replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    func firstMatch(_ pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: self, range: NSRange(startIndex..., in: self)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: self) else { return nil }
        return String(self[range])
    }
}
