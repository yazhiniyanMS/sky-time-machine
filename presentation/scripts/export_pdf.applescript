-- Export the deck to PDF with Keynote (macOS). Usage:
--   osascript scripts/export_pdf.applescript /abs/path/deck.pptx /abs/path/deck.pdf
on run argv
	set inPath to POSIX file (item 1 of argv)
	set outPath to POSIX file (item 2 of argv)
	tell application id "com.apple.Keynote"
		set theDoc to open inPath
		delay 2
		export theDoc to outPath as PDF with properties {PDF image quality:Best}
		close theDoc saving no
	end tell
end run
