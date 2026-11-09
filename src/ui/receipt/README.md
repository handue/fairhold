Owner area: screen 11, the receipt (mockups/11, design/25), and 25b, its printable page, from `src/server/queries/receipt-view.ts`.

- `ReceiptScreen`: the thank-you and the lots beside the receipt, in four phases: paid (the snapshot), pending (what the charge will be), released and release_pending (won nothing). "Sandbox demo · not a tax document" is on the receipt's first line in every phase, and the charity's details read as placeholders (decision C5). `<LiveRefresh>` turns pending into paid by itself.
- `ReceiptPdf` and `receipt-pdf.css`: 25b's US Letter sheet. "Download PDF" (`DownloadPdfButton`) prints it with the page's title set to the file name; the print stylesheet keeps only the sheet, edge to edge, with its bands and watermark. Only a guest with a receipt gets it.
- "Email me a copy" opens a draft in the guest's own mail app; Fairhold sends no mail.
- `copy.ts`: every sentence that depends on the figures, shared by the page and the PDF.
