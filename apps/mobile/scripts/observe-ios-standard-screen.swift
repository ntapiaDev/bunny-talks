import CoreGraphics
import Darwin
import Foundation
import Vision

// Print only a fixed verdict. The image and recognized text stay on the runner.
func screenMatches(_ url: URL) throws -> Bool {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["fr-FR", "en-US"]
    request.usesLanguageCorrection = false
    request.usesCPUOnly = true
    try VNImageRequestHandler(url: url, options: [:]).perform([request])

    let locale = Locale(identifier: "fr_FR")
    let anchors = ["diagnostic local opene2ee", "tester connexion api", "controles rapides du coffre"]
    var above: CGFloat = 1
    for anchor in anchors {
        let rows = (request.results ?? []).filter { row in
            guard let candidate = row.topCandidates(1).first, candidate.confidence >= 0.5 else {
                return false
            }
            return candidate.string.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: locale) == anchor
        }
        guard rows.count == 1, let row = rows.first, row.boundingBox.midY < above else {
            return false
        }
        above = row.boundingBox.midY
    }
    return true
}

guard CommandLine.arguments.count == 2 else { exit(2) }
do {
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    print(try screenMatches(url) ? "MATCH" : "NO_MATCH")
} catch {
    exit(2)
}
