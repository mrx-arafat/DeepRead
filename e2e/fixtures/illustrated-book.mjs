// A generated book keeps the browser test independent of copyrighted books and OCR availability.
export function illustratedBookPdf() {
  const draw = (text, y, font = "F1", x = 50) =>
    `0 0 0 rg BT /${font} 12 Tf 1 0 0 1 ${x} ${y} Tm (${text.replace(/([\\()])/g, "\\$1")}) Tj ET`;
  const content = [
    draw("Read the", 760), draw("bold words", 760, "F3", 100), draw("and", 760, "F1", 175), draw("italic words", 760, "F4", 200), draw("in this sentence.", 760, "F1", 270),
    draw("This paragraph appears before the illustration in the book.", 730),
    "0.15 0.4 0.7 rg 80 440 360 180 re f",
    draw("Figure 1. A blue illustration", 425, "F4", 230),
    draw("This paragraph appears after the illustration in the book.", 410),
    draw("1. First printed list item stays separate", 370),
    draw("2. Second printed list item stays separate", 350),
    draw("function sample() {", 310, "F2"),
    draw("  return 42;", 294, "F2"),
    draw("}", 278, "F2"),
    ...[230, 210, 190].flatMap((y, n) => [draw(["Item", "Apples", "Oranges"][n], y), draw(["Quantity", "12", "24"][n], y, "F1", 210), draw(["Unit", "each", "each"][n], y, "F1", 350)]),
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, at) => {
    const offset = pdf.length;
    pdf += `${at + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
