"use client";

/**
 * Renders legal document text with markdown pipe table support.
 * Splits text into paragraphs and tables, rendering tables as proper HTML.
 */
export function LegalText({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: Array<{ type: "text"; content: string } | { type: "table"; headers: string[]; rows: string[][] }> = [];

  let currentText = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect markdown table: line with pipes, followed by separator (|---|---|)
    if (line.includes("|") && i + 1 < lines.length && /^\|[\s-:|]+\|$/.test(lines[i + 1].trim())) {
      // Flush any accumulated text
      if (currentText.trim()) {
        blocks.push({ type: "text", content: currentText.trim() });
        currentText = "";
      }

      // Parse header row
      const headers = line.split("|").map((s) => s.trim()).filter(Boolean);

      // Skip separator row
      i += 2;

      // Parse data rows
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && !lines[i].trim().startsWith("|---")) {
        const cells = lines[i].split("|").map((s) => s.trim()).filter(Boolean);
        if (cells.length > 0) rows.push(cells);
        i++;
      }

      blocks.push({ type: "table", headers, rows });
      continue;
    }

    currentText += line + "\n";
    i++;
  }

  // Flush remaining text
  if (currentText.trim()) {
    blocks.push({ type: "text", content: currentText.trim() });
  }

  return (
    <div className="space-y-6">
      {blocks.map((block, idx) => {
        if (block.type === "text") {
          return (
            <pre key={idx} className="whitespace-pre-wrap font-sans text-base text-gray-700 leading-relaxed">
              {block.content}
            </pre>
          );
        }

        return (
          <div key={idx} className="overflow-x-auto">
            <table className="w-full text-sm border border-gray-200 rounded-lg overflow-hidden">
              <thead className="bg-gray-50">
                <tr>
                  {block.headers.map((h, hi) => (
                    <th key={hi} className="px-4 py-3 text-left font-semibold text-gray-700 border-b border-gray-200">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {block.rows.map((row, ri) => (
                  <tr key={ri} className="hover:bg-gray-50">
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-4 py-3 text-gray-600">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
