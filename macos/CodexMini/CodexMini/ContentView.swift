import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var service: ServiceManager

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            statusPanel
            actionPanel
            Spacer(minLength: 0)
            bottomBar
        }
        .padding(24)
        .background(
            LinearGradient(colors: [Color(red: 0.06, green: 0.07, blue: 0.09), Color(red: 0.10, green: 0.11, blue: 0.15)], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .foregroundStyle(.white)
        .alert("Codex Mini", isPresented: $service.showAlert) {
            Button("好") {}
        } message: {
            Text(service.alertMessage)
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: "iphone.and.arrow.forward")
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(.cyan)
            VStack(alignment: .leading, spacing: 4) {
                Text(service.appName)
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                Text("本地部署版 · 手机连接这台 Mac 上的 Codex")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.55))
            }
            Spacer()
            StatusBadge(title: service.state.displayName, color: service.statusColor)
        }
    }

    private var statusPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                MetricCard(title: "HTTP", value: service.healthOK ? "正常" : "不可用", footnote: service.healthText, tint: service.healthOK ? .green : .orange)
                MetricCard(title: "端口", value: String(service.port), footnote: service.currentEntryKindText, tint: .cyan)
                MetricCard(title: "线程", value: service.threadCountText, footnote: service.latestThreadTitle, tint: .purple)
            }
            Text(service.shortInstallDirectory)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.45))
                .lineLimit(1)
        }
        .padding(16)
        .panelBackground(cornerRadius: 22)
    }

    private var actionPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("常用操作")
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                    Text("只保留本机服务、局域网访问和本地日志")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.white.opacity(0.42))
                }
                Spacer()
                Text(service.lastUpdatedText)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.42))
            }

            HStack(spacing: 10) {
                LargeActionButton(title: "打开网页", systemImage: "safari", tint: .blue) { service.openWeb() }
                LargeActionButton(title: service.currentCopyButtonTitle, systemImage: "link", tint: .cyan) { service.copyLocalLink() }
                LargeActionButton(title: "重启服务", systemImage: "arrow.clockwise", tint: .orange) { Task { await service.restart() } }
                LargeActionButton(title: "刷新状态", systemImage: "arrow.triangle.2.circlepath", tint: .gray) { Task { await service.refresh() } }
            }
        }
        .padding(16)
        .panelBackground(cornerRadius: 22)
    }

    private var bottomBar: some View {
        HStack(spacing: 12) {
            Label(service.logPreview.isEmpty ? "暂无最近日志" : "最近日志已收起，完整内容可从右侧打开", systemImage: "doc.text")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white.opacity(0.42))
                .lineLimit(1)
            Spacer(minLength: 16)
            VStack(alignment: .trailing, spacing: 2) {
                Text(service.currentEntryKindText)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white.opacity(0.30))
                Text(service.currentEntryURLString)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.38))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            TextLinkButton(title: "打开日志", systemImage: "doc.text.magnifyingglass") { service.openLogs() }
            TextLinkButton(title: service.state == .running || service.healthOK ? "停止" : "启动", systemImage: service.state == .running || service.healthOK ? "stop.fill" : "play.fill") {
                Task { service.state == .running || service.healthOK ? await service.stop() : await service.start() }
            }
        }
    }
}

private extension View {
    func panelBackground(cornerRadius: CGFloat) -> some View {
        self
            .background(.white.opacity(0.055), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).stroke(.white.opacity(0.08)))
    }
}

private struct StatusBadge: View {
    let title: String
    let color: Color
    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 8, height: 8).shadow(color: color.opacity(0.75), radius: 7)
            Text(title).font(.system(size: 12, weight: .bold)).lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(color.opacity(0.15), in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.32)))
    }
}

private struct MetricCard: View {
    let title: String
    let value: String
    let footnote: String
    let tint: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 11, weight: .bold)).foregroundStyle(.white.opacity(0.45))
            Text(value).font(.system(size: 24, weight: .bold, design: .rounded)).foregroundStyle(tint)
            Text(footnote).font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.42)).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(tint.opacity(0.18)))
    }
}

private struct LargeActionButton: View {
    let title: String
    let systemImage: String
    let tint: Color
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 9) {
                Image(systemName: systemImage).font(.system(size: 20, weight: .bold))
                Text(title).font(.system(size: 12, weight: .bold)).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 74)
            .background(tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(tint.opacity(0.28)))
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
    }
}

private struct TextLinkButton: View {
    let title: String
    let systemImage: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 12, weight: .bold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white.opacity(0.58))
    }
}
