// Runs on macOS against the screenshot captured by the iOS simulator job.
import Foundation
import ImageIO
import Vision

let path = CommandLine.arguments[1]
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(url: URL(fileURLWithPath: path)).perform([request])
let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
print(text)
guard text.contains("Kinetik"), text.contains("Connect ChatGPT"),
      !text.localizedCaseInsensitiveContains("Could not read protected credentials"),
      !text.localizedCaseInsensitiveContains("Try again") else {
    fputs("iOS did not reach usable onboarding. Inspect the launch screenshot.\n", stderr)
    exit(1)
}
