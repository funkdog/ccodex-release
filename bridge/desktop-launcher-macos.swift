import AppKit
import Foundation

// A tiny UI shell around desktop-shortcut.mjs, with no Desktop internals.
struct LauncherBinding: Decodable {
    let schemaVersion: Int
    let managedBy: String
    let node: String
    let root: String
    let configFile: String
    let application: String
}

func binding() throws -> LauncherBinding {
    guard let url = Bundle.main.url(forResource: "launcher", withExtension: "json") else {
        throw NSError(domain: "MyCodex", code: 1, userInfo: [NSLocalizedDescriptionKey: "启动配置缺失，请重新安装 MyCodex 入口。"])
    }
    let value = try JSONDecoder().decode(LauncherBinding.self, from: Data(contentsOf: url))
    guard value.schemaVersion == 1, value.managedBy == "ccodex-current-host-launcher",
          [value.node, value.root, value.configFile, value.application].allSatisfy({ $0.hasPrefix("/") }) else {
        throw NSError(domain: "MyCodex", code: 2, userInfo: [NSLocalizedDescriptionKey: "启动配置无效。"])
    }
    return value
}

func run(_ config: LauncherBinding, checkOnly: Bool) throws -> (Data, Int32) {
    let child = Process(), output = Pipe()
    child.executableURL = URL(fileURLWithPath: config.node)
    child.arguments = [config.root + "/bridge/desktop-shortcut.mjs", "--config", config.configFile] + (checkOnly ? ["--check"] : [])
    child.currentDirectoryURL = URL(fileURLWithPath: config.root)
    child.standardOutput = output
    child.standardError = FileHandle.nullDevice
    try child.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    child.waitUntilExit()
    return (data, child.terminationStatus)
}

// The native launcher can still open the stock app when its external Node
// runtime moved or the JavaScript compatibility path cannot start.
func verifiedStockApplication(_ application: String) -> Bool {
    guard application.hasPrefix("/"), application.hasSuffix(".app") else { return false }
    func codesign(_ arguments: [String]) -> (Int32, String)? {
        let job = Process(), output = Pipe()
        job.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        job.arguments = arguments; job.standardOutput = output; job.standardError = output
        do { try job.run() } catch { return nil }
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        job.waitUntilExit(); return (job.terminationStatus, text)
    }
    guard let verification = codesign(["--verify", "--deep", "--strict", application]), verification.0 == 0,
          let identity = codesign(["-dv", "--verbose=4", application]), identity.0 == 0 else { return false }
    return identity.1.contains("Identifier=com.openai.codex\n") && identity.1.contains("TeamIdentifier=2DC432GLL2\n")
}

func makeIcon(_ directory: String) throws {
    for size in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let pixels = size * scale
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0)!
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            let s = CGFloat(pixels)
            NSColor(calibratedRed: 0.08, green: 0.13, blue: 0.18, alpha: 1).setFill()
            NSBezierPath(roundedRect: NSRect(x: s * 0.06, y: s * 0.06, width: s * 0.88, height: s * 0.88),
                xRadius: s * 0.20, yRadius: s * 0.20).fill()
            NSColor(calibratedRed: 0.42, green: 0.91, blue: 0.76, alpha: 1).setStroke()
            let mark = NSBezierPath(); mark.lineWidth = s * 0.075; mark.lineCapStyle = .round; mark.lineJoinStyle = .round
            mark.move(to: NSPoint(x: s * 0.26, y: s * 0.66)); mark.line(to: NSPoint(x: s * 0.43, y: s * 0.50)); mark.line(to: NSPoint(x: s * 0.26, y: s * 0.34))
            mark.move(to: NSPoint(x: s * 0.55, y: s * 0.35)); mark.line(to: NSPoint(x: s * 0.75, y: s * 0.35)); mark.stroke()
            NSGraphicsContext.restoreGraphicsState()
            let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
            try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
        }
    }
}

struct StatusFeature: Decodable { let id: String; let label: String; let state: String; let detail: String; var stateLabel: String? = nil }
struct StatusSnapshot: Decodable {
    let schemaVersion: Int; let level: String; let title: String; let summary: String
    let features: [StatusFeature]; let steps: String; let incident: String
    let appPid: Int?; let observedAt: String; let notice: String?
    var menuLabel: String? = nil; var launchAvailable: Bool? = nil
}

// BEGIN STATUS ATTENTION
struct AttentionDecision { let popup: Bool; let recovered: Bool }
// The native shell owns attention. Remember a feature already surfaced across
// watcher refreshes, Dock reopens and launcher restarts. Cause text is not an ID.
final class StatusAttention {
    private var seen: Set<String>, healthySince: [String: TimeInterval] = [:]
    private let write: (Set<String>) -> Void
    init(read: () -> Set<String>, write: @escaping (Set<String>) -> Void) {
        self.seen = read(); self.write = write
    }
    func update(_ value: StatusSnapshot, now: TimeInterval = Date().timeIntervalSince1970) -> AttentionDecision {
        let previous = seen
        var failed = value.level == "warning" ? value.features.filter { $0.state == "unavailable" }.map { $0.id } : []
        if value.level == "warning" && failed.isEmpty { failed = ["monitor"] }
        var recovered = false, popup = false
        for feature in seen {
            let healthy = feature == "monitor" ? value.level == "ok" : value.features.contains { $0.id == feature && $0.state == "ready" }
            if !healthy { healthySince.removeValue(forKey: feature) }
            else if let since = healthySince[feature] {
                if now - since >= 30 { seen.remove(feature); healthySince.removeValue(forKey: feature); recovered = true }
                else if now < since { healthySince[feature] = now }
            } else { healthySince[feature] = now }
        }
        for feature in failed where !seen.contains(feature) { seen.insert(feature); healthySince.removeValue(forKey: feature); popup = true }
        if previous != seen { write(seen) }
        return AttentionDecision(popup: popup, recovered: recovered)
    }
}
// END STATUS ATTENTION

// An independent native window. No renderer selectors, CDP, notifications
// entitlement or modal alerts are needed to make compatibility failures visible.
final class StatusSurface: NSView {
    var fillColor: NSColor?, radius: CGFloat = 0
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if let color = fillColor {
            color.setFill(); NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
        }
    }
}

final class StatusPanel {
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 420),
        styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
    var onRefresh: (() -> Void)?
    private var actionButton: NSButton?, launchAvailable = false, starting = false
    init() {
        panel.title = "MyCodex · 兼容状态"; panel.isReleasedWhenClosed = false
        panel.level = .floating; panel.hidesOnDeactivate = false
    }
    private func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular,
                       color: NSColor = .labelColor) -> NSTextField {
        let view = NSTextField(wrappingLabelWithString: text)
        view.font = .systemFont(ofSize: size, weight: weight); view.textColor = color
        view.preferredMaxLayoutWidth = 432; view.isSelectable = true
        return view
    }
    func update(_ status: StatusSnapshot) {
        launchAvailable = status.launchAvailable == true
        let width: CGFloat = 480, inset: CGFloat = 24
        let background = StatusSurface(frame: NSRect(x: 0, y: 0, width: width, height: 500))
        background.fillColor = .windowBackgroundColor
        // Explicit native frames keep wrapping text measurable before a window
        // is shown, including first launch and inactive nonmodal presentation.
        func text(_ value: String, x: CGFloat, top: CGFloat, width: CGFloat,
                  size: CGFloat = 13, weight: NSFont.Weight = .regular, color: NSColor = .labelColor,
                  in parent: NSView = background) -> CGFloat {
            let field = label(value, size: size, weight: weight, color: color)
            let measured = (value as NSString).boundingRect(with: NSSize(width: width, height: 2000),
                options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: field.font!]).height
            let height = ceil(measured) + 5
            field.frame = NSRect(x: x, y: top, width: width, height: height)
            parent.addSubview(field); return height
        }
        // AppKit's default coordinate system is bottom-up. A flipped surface
        // lets every row below use a single top-to-bottom layout calculation.
        let content = StatusSurface(frame: background.bounds)
        content.autoresizingMask = [.width, .height]; background.addSubview(content)
        let color: NSColor = status.level == "warning" ? .systemOrange : status.level == "ok" ? .systemGreen : .secondaryLabelColor
        let image = NSImageView(image: NSImage(systemSymbolName: status.level == "warning" ? "exclamationmark.circle.fill" : status.level == "info" ? "clock" : "checkmark.circle.fill", accessibilityDescription: nil)!)
        image.contentTintColor = color; image.frame = NSRect(x: inset, y: inset + 3, width: 22, height: 22)
        content.addSubview(image)
        var y = inset + text(status.notice == "recovered" ? "增强接入已恢复" : status.title,
            x: inset + 32, top: inset, width: width - inset * 2 - 32, size: 21, weight: .semibold, in: content) + 10
        y += text(status.summary, x: inset, top: y, width: width - inset * 2, color: .secondaryLabelColor, in: content) + 18
        for feature in status.features {
            let card = StatusSurface(frame: NSRect(x: inset, y: y, width: width - inset * 2, height: 100))
            card.fillColor = .controlBackgroundColor; card.radius = 10
            let state = feature.stateLabel ?? (feature.state == "ready" ? "可用" : feature.state == "checking" ? "检查中" : "需关注")
            _ = text(feature.label, x: 14, top: 12, width: card.frame.width - 94, size: 13, weight: .semibold, in: card)
            _ = text(state, x: card.frame.width - 64, top: 12, width: 52, size: 12, weight: .medium,
                color: feature.state == "ready" ? .systemGreen : feature.state == "checking" ? .secondaryLabelColor : .systemOrange, in: card)
            let height = text(feature.detail, x: 14, top: 39, width: card.frame.width - 28,
                size: 12, color: .secondaryLabelColor, in: card)
            card.setFrameSize(NSSize(width: card.frame.width, height: 39 + height + 12))
            content.addSubview(card); y += card.frame.height + 12
        }
        y += 4 + text(status.steps, x: inset, top: y + 4, width: width - inset * 2, size: 12, color: .secondaryLabelColor, in: content) + 12
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: status.observedAt) ?? ISO8601DateFormatter().date(from: status.observedAt) {
            let format = DateFormatter(); format.dateFormat = "HH:mm:ss"
            y += text("上次检查 \(format.string(from: date)) · 每 15 秒自动检查", x: inset, top: y,
                width: width - inset * 2, size: 11, color: .secondaryLabelColor, in: content) + 14
        }
        let refresh = NSButton(title: starting ? "启动中…" : launchAvailable ? "启动 ChatGPT" : "重新检查", target: self, action: #selector(recheck))
        let close = NSButton(title: "稍后查看", target: self, action: #selector(dismiss))
        refresh.bezelStyle = .rounded; close.bezelStyle = .rounded
        refresh.isEnabled = !starting; actionButton = refresh
        refresh.sizeToFit(); close.sizeToFit()
        refresh.setFrameOrigin(NSPoint(x: inset, y: y)); close.setFrameOrigin(NSPoint(x: inset + refresh.frame.width + 8, y: y))
        content.addSubview(refresh); content.addSubview(close)
        let height = y + max(refresh.frame.height, close.frame.height) + inset
        let size = NSSize(width: width, height: height)
        panel.setContentSize(size); background.setFrameSize(size); content.setFrameSize(size)
        panel.contentView = background
    }
    func setStarting(_ value: Bool) {
        starting = value
        actionButton?.title = value ? "启动中…" : launchAvailable ? "启动 ChatGPT" : "重新检查"
        actionButton?.isEnabled = !value
    }
    func show(manual: Bool) {
        if manual { NSApp.activate(ignoringOtherApps: true); panel.makeKeyAndOrderFront(nil) }
        else if !panel.isVisible {
            let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            panel.setFrameTopLeftPoint(NSPoint(x: visible.maxX - panel.frame.width - 20, y: visible.maxY - 16))
            panel.orderFrontRegardless()
        }
    }
    @objc private func recheck() { onRefresh?() }
    @objc private func dismiss() { panel.close() }
}

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    private var busy = false, statusItem: NSStatusItem!, monitor: Process?, monitorGeneration = UUID()
    private var latest: StatusSnapshot?, config: LauncherBinding?
    private let statusPanel = StatusPanel()
    private var recoveredUntil: TimeInterval = 0
    private lazy var attention: StatusAttention = {
        let key = "compatibility-notices-v2:" + ((try? binding())?.configFile ?? Bundle.main.bundlePath)
        return StatusAttention(read: { Set(UserDefaults.standard.stringArray(forKey: key) ?? []) },
            write: { UserDefaults.standard.set(Array($0).sorted(), forKey: key) })
    }()
    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "MyCodex"
        let menu = NSMenu()
        for (title, selector) in [("查看兼容状态…", #selector(showStatus)), ("重新检查（不重启）", #selector(refresh)),
                                   ("退出状态提示", #selector(quitMonitor))] {
            let item = NSMenuItem(title: title, action: selector, keyEquivalent: ""); item.target = self; menu.addItem(item)
        }
        statusItem.menu = menu; statusPanel.onRefresh = { [weak self] in self?.primaryAction() }; start()
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        start(); return false
    }
    func applicationWillTerminate(_ notification: Notification) { stopMonitor() }
    @objc private func showStatus() { if let value = latest { statusPanel.update(value); statusPanel.show(manual: true) } }
    @objc private func refresh() { if let value = config { startMonitor(value) } else { start() } }
    private func primaryAction() { if latest?.launchAvailable == true { start() } else { refresh() } }
    @objc private func quitMonitor() { NSApp.terminate(nil) }
    private func receive(_ value: StatusSnapshot) {
        guard value.schemaVersion == 1, ["ok", "info", "warning"].contains(value.level) else { return }
        let decision = attention.update(value), now = Date().timeIntervalSince1970
        latest = value
        if decision.recovered { recoveredUntil = now + 30 }
        statusItem.button?.title = value.level == "warning" ? "MyCodex !"
            : now < recoveredUntil ? (value.level == "ok" ? "MyCodex · 已恢复" : "MyCodex · 状态更新")
            : value.menuLabel ?? "MyCodex"
        statusItem.button?.toolTip = value.title + "\n" + value.summary
        statusPanel.update(value)
        if decision.popup { statusPanel.show(manual: false) }
    }
    private func showFailure(_ message: String) {
        receive(StatusSnapshot(schemaVersion: 1, level: "warning", title: "MyCodex 接入需要关注",
            summary: String(message.prefix(1000)), features: [],
            steps: "当前会话没有被自动关闭。可从菜单栏重新检查或稍后查看。", incident: "launcher-error",
            appPid: nil, observedAt: ISO8601DateFormatter().string(from: Date()), notice: "degraded"))
    }
    private func startOfficialFallback(_ value: LauncherBinding, reason: String) {
        DispatchQueue.global(qos: .userInitiated).async {
            let trusted = verifiedStockApplication(value.application)
            DispatchQueue.main.async {
                guard trusted else {
                    self.showFailure("官方 ChatGPT 签名无法验证，未自动启动。\n" + reason)
                    self.statusPanel.show(manual: true); self.busy = false; self.statusPanel.setStarting(false)
                    return
                }
                NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: value.application),
                                                   configuration: NSWorkspace.OpenConfiguration()) { app, error in
                    DispatchQueue.main.async {
                        if let app = app { app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) }
                        self.showFailure(app == nil
                            ? "官方 ChatGPT 启动失败：\(error?.localizedDescription ?? "未知错误")\n" + reason
                            : "官方 ChatGPT 已按原版方式打开；MyCodex 增强待修复。\n" + reason)
                        self.statusPanel.show(manual: true)
                        self.busy = false; self.statusPanel.setStarting(false)
                        if self.monitor?.isRunning != true { self.startMonitor(value) }
                    }
                }
            }
        }
    }
    private func stopMonitor() {
        monitorGeneration = UUID()
        if let job = monitor, job.isRunning { job.terminate() }
        monitor = nil
    }
    private func startMonitor(_ value: LauncherBinding) {
        stopMonitor(); let generation = monitorGeneration, child = Process(), output = Pipe()
        child.executableURL = URL(fileURLWithPath: value.node)
        child.arguments = [value.root + "/bridge/desktop-status.mjs", "--config", value.configFile, "--watch"]
        child.currentDirectoryURL = URL(fileURLWithPath: value.root)
        child.standardOutput = output; child.standardError = FileHandle.nullDevice
        do { try child.run(); monitor = child }
        catch { showFailure("状态监测无法启动：\(error.localizedDescription)"); return }
        DispatchQueue.global(qos: .utility).async {
            var buffer = Data()
            while true {
                let data = output.fileHandleForReading.availableData
                if data.isEmpty { break }
                buffer.append(data)
                if buffer.count > 256 * 1024 { child.terminate(); break }
                while let end = buffer.firstIndex(of: 10) {
                    let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
                    guard let status = try? JSONDecoder().decode(StatusSnapshot.self, from: line) else { continue }
                    DispatchQueue.main.async { if self.monitorGeneration == generation { self.receive(status) } }
                }
            }
            child.waitUntilExit()
            DispatchQueue.main.async {
                if self.monitorGeneration == generation { self.showFailure("状态监测已停止；不能确认当前增强状态。请从菜单栏重新检查。") }
            }
        }
    }
    private func start() {
        if busy { return }; busy = true; statusPanel.setStarting(true)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let config = try binding(), (data, code) = try run(config, checkOnly: false)
                guard !data.isEmpty, let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw NSError(domain: "MyCodex", code: 3, userInfo: [NSLocalizedDescriptionKey: "启动器没有返回有效结果（退出码 \(code)）。请检查源码构建状态和后端日志。"])
                }
                DispatchQueue.main.async {
                    self.config = config
                    if code == 0, ["started", "activate-existing"].contains(result["action"] as? String ?? ""),
                       let pid = result["pid"] as? Int, let app = NSRunningApplication(processIdentifier: pid_t(pid)),
                       app.bundleURL?.standardizedFileURL == URL(fileURLWithPath: config.application).standardizedFileURL {
                        app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
                    } else if result["backendReason"] as? String != "update-pending" {
                        self.startOfficialFallback(config, reason: result["message"] as? String ?? "增强尚未完成启动。")
                        return
                    }
                    self.busy = false
                    self.statusPanel.setStarting(false)
                    if self.monitor?.isRunning != true { self.startMonitor(config) }
                }
            } catch {
                if let config = try? binding() {
                    DispatchQueue.main.async { self.startOfficialFallback(config, reason: error.localizedDescription) }
                } else {
                    DispatchQueue.main.async {
                        self.busy = false; self.statusPanel.setStarting(false)
                        self.showFailure("MyCodex 启动配置无效：\(error.localizedDescription)")
                        self.statusPanel.show(manual: true)
                    }
                }
            }
        }
    }
}

do {
    if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--make-icon" {
        try makeIcon(CommandLine.arguments[2]); exit(0)
    }
    if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--check" {
        let (data, code) = try run(binding(), checkOnly: true)
        FileHandle.standardOutput.write(data); exit(code)
    }
    let app = NSApplication.shared, delegate = LauncherDelegate()
    app.setActivationPolicy(.accessory); app.delegate = delegate; app.run()
} catch {
    FileHandle.standardError.write(Data("MyCodex: \(error.localizedDescription)\n".utf8)); exit(1)
}
