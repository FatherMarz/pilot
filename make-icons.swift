// make-icons.swift — render the Pilot icon set (16/32/48/128) as PNGs.
// Matches the popover logo: ink→teal gradient rounded square + white "P".
// Usage: swift make-icons.swift
import AppKit

let outputDir = "extension/icons"
try! FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)

func drawIcon(size: Int) -> NSImage {
    let s = CGFloat(size)
    let img = NSImage(size: NSSize(width: s, height: s))
    img.lockFocus()

    // Rounded rect background: ink → teal gradient (matches popover logo).
    let bg = NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: s, height: s), xRadius: s * 0.22, yRadius: s * 0.22)
    let grad = NSGradient(colors: [
        NSColor(calibratedRed: 0.059, green: 0.078, blue: 0.098, alpha: 1),   // #0f1419 ink
        NSColor(calibratedRed: 0.086, green: 0.129, blue: 0.122, alpha: 1),   // #16211f
        NSColor(calibratedRed: 0.0, green: 0.639, blue: 0.639, alpha: 1),     // #00a3a3 teal
    ])!
    grad.draw(in: bg, angle: 145)

    // Bold white "P" — geometric sans, centered.
    let font = NSFont.systemFont(ofSize: s * 0.62, weight: .bold)
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor.white,
        .paragraphStyle: paragraph,
    ]
    let str = NSAttributedString(string: "P", attributes: attrs)
    let bounds = str.boundingRect(with: NSSize(width: s, height: s), options: [.usesLineFragmentOrigin])
    str.draw(in: NSRect(
        x: (s - bounds.width) / 2,
        y: (s - bounds.height) / 2,
        width: bounds.width,
        height: bounds.height
    ))

    img.unlockFocus()
    return img
}

for size in [16, 32, 48, 128] {
    let img = drawIcon(size: size)
    let tiff = img.tiffRepresentation!
    let rep = NSBitmapImageRep(data: tiff)!
    let png = rep.representation(using: .png, properties: [:])!
    let path = "\(outputDir)/icon\(size).png"
    try! png.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}
