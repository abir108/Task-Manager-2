/* Minimal .xlsx writer with no dependencies: styled sheets, column widths, frozen header rows,
   filters and merged cells. A workbook is a plain zip of XML files, written here uncompressed.

   XlsxLite.build(sheets) -> Uint8Array          XlsxLite.download(filename, sheets)
   sheet = { name, widths: [..], rows: [[cell, ..], ..], freeze: <rows to keep visible>,
             filter: { row, fromCol, toCol }, merges: ["A1:F1"], landscape: true }
   cell  = string | number | null | { v: string|number|null, s: "styleName" }
   Styles: normal title subtitle muted header headerLeft text textWrap center int num pct
           totalText totalInt totalNum totalPct good warn bad label */
(function (root) {
  const encoder = new TextEncoder();

  /* ---------- zip (store, no compression) ---------- */
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach(file => {
      const name = encoder.encode(file.name);
      const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);          // UTF-8 names
      local.setUint16(8, 0, true);               // stored
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(10, 0, true);
      entry.setUint16(12, dosTime, true);
      entry.setUint16(14, dosDate, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);
      central.push(new Uint8Array(entry.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const centralSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    all.forEach(p => { out.set(p, pos); pos += p.length; });
    return out;
  }

  /* ---------- styles ---------- */
  const NUM_POINTS = 164;   // #,##0.##
  const NUM_PCT = 165;      // 0.0%
  // [name, font, fill, border, numFmt, alignment]
  const XF = [
    ["normal", 0, 0, 0, 0, null],
    ["title", 2, 0, 0, 0, null],
    ["subtitle", 5, 0, 0, 0, null],
    ["muted", 4, 0, 0, 0, null],
    ["header", 3, 2, 1, 0, 'horizontal="center" vertical="center" wrapText="1"'],
    ["headerLeft", 3, 2, 1, 0, 'horizontal="left" vertical="center" wrapText="1"'],
    ["text", 0, 0, 1, 0, 'vertical="center"'],
    ["textWrap", 0, 0, 1, 0, 'vertical="center" wrapText="1"'],
    ["center", 0, 0, 1, 0, 'horizontal="center" vertical="center"'],
    ["int", 0, 0, 1, 1, 'horizontal="center" vertical="center"'],
    ["num", 0, 0, 1, NUM_POINTS, 'horizontal="center" vertical="center"'],
    ["pct", 0, 0, 1, NUM_PCT, 'horizontal="center" vertical="center"'],
    ["totalText", 1, 3, 1, 0, 'vertical="center"'],
    ["totalInt", 1, 3, 1, 1, 'horizontal="center" vertical="center"'],
    ["totalNum", 1, 3, 1, NUM_POINTS, 'horizontal="center" vertical="center"'],
    ["totalPct", 1, 3, 1, NUM_PCT, 'horizontal="center" vertical="center"'],
    ["good", 6, 4, 1, NUM_PCT, 'horizontal="center" vertical="center"'],
    ["warn", 7, 6, 1, NUM_PCT, 'horizontal="center" vertical="center"'],
    ["bad", 8, 5, 1, NUM_PCT, 'horizontal="center" vertical="center"'],
    ["label", 1, 3, 1, 0, 'vertical="center"']
  ];
  const STYLE_INDEX = {};
  XF.forEach((x, i) => { STYLE_INDEX[x[0]] = i; });

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="${NUM_POINTS}" formatCode="#,##0.##"/><numFmt numFmtId="${NUM_PCT}" formatCode="0.0%"/></numFmts>
<fonts count="9">
<font><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="18"/><color rgb="FF112E81"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><i/><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="12"/><color rgb="FF4647AE"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF0F7B4D"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF9A6200"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFB42318"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="7">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF112E81"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEAF0FB"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3F5EC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDE8E6"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3D6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD3DAE8"/></left><right style="thin"><color rgb="FFD3DAE8"/></right><top style="thin"><color rgb="FFD3DAE8"/></top><bottom style="thin"><color rgb="FFD3DAE8"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${XF.length}">
${XF.map(([, font, fill, border, numFmt, align]) =>
    `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"${numFmt ? ' applyNumberFormat="1"' : ""} applyFont="1" applyFill="1" applyBorder="1"${align ? ` applyAlignment="1"><alignment ${align}/></xf>` : "/>"}`).join("\n")}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  /* ---------- sheets ---------- */
  const esc = s => String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function colName(index) {            // 0 -> A, 26 -> AA
    let n = index + 1, name = "";
    while (n > 0) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); }
    return name;
  }

  function cellXml(cell, ref) {
    let value = cell, style = 0;
    if (cell && typeof cell === "object") {
      value = cell.v;
      style = STYLE_INDEX[cell.s] || 0;
    }
    const s = style ? ` s="${style}"` : "";
    if (value === null || value === undefined || value === "") return style ? `<c r="${ref}"${s}/>` : "";
    if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
    return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  }

  function sheetXml(sheet) {
    const rows = sheet.rows.map((cells, r) => {
      const inner = cells.map((cell, c) => cellXml(cell, colName(c) + (r + 1))).join("");
      const height = sheet.heights && sheet.heights[r] ? ` ht="${sheet.heights[r]}" customHeight="1"` : "";
      return inner || height ? `<row r="${r + 1}"${height}>${inner}</row>` : "";
    }).join("");
    const cols = (sheet.widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
    const pane = sheet.freeze
      ? `<pane ySplit="${sheet.freeze}" topLeftCell="A${sheet.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>`
      : "";
    const filter = sheet.filter
      ? `<autoFilter ref="${colName(sheet.filter.fromCol)}${sheet.filter.row}:${colName(sheet.filter.toCol)}${sheet.filter.lastRow || sheet.filter.row}"/>`
      : "";
    const merges = (sheet.merges || []).length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView showGridLines="0" workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows}</sheetData>${filter}${merges}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup orientation="${sheet.landscape === false ? "portrait" : "landscape"}" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  }

  /* Excel sheet names: at most 31 characters, none of []:*?/\ and each one unique. */
  function sheetNames(sheets) {
    const used = new Set();
    return sheets.map(sheet => {
      let base = String(sheet.name || "Sheet").replace(/[\[\]:*?\/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || "Sheet";
      let name = base, n = 2;
      while (used.has(name.toLowerCase())) {
        const suffix = ` (${n++})`;
        name = base.slice(0, 31 - suffix.length) + suffix;
      }
      used.add(name.toLowerCase());
      return name;
    });
  }

  function build(sheets) {
    const names = sheetNames(sheets);
    const files = [
      { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
      { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: "xl/styles.xml", data: STYLES_XML },
      ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) }))
    ];
    return zip(files);
  }

  function download(filename, sheets) {
    const bytes = build(sheets);
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const api = { build, download, sheetNames };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.XlsxLite = api;
})(typeof self !== "undefined" ? self : this);
