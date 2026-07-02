// LINE / 純文字輸出轉換。LINE 純文字泡泡沒有「懸掛縮排」：一行太長換行時第二行會貼回最左，
// 任何前導空格/縮排在窄螢幕都會歪掉。所以這裡「設計成不需要對齊」：全部靠左、零縮排，
// 標題與內容拆成兩行，巢狀子項目壓平成同層「・」。網站版不走這裡（維持原本 Markdown）。

// 拿掉模型在答案結尾產生的【資料來源：…】【後續問題：…】區塊（LINE 不能點、無意義）。
function stripSourceFooter(text) {
  return String(text || '')
    .replace(/【\s*資料來源[\s\S]*?】/g, '')
    .replace(/【\s*後續問題[\s\S]*?】/g, '')
    .trim();
}

const LINK_FILLER = /^(點此開啟|點我|點擊|點這裡|按這裡|連結|網址|link|here|click(?:\s*here)?)$/i;

// 行內 Markdown → 純文字：粗體/斜體/行內碼/連結。
function inlineClean(s) {
  let t = String(s || '');
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');
  t = t.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1$2');
  t = t.replace(/`([^`]+)`/g, '$1');
  // [文字](網址)：保留「文字：網址」（LINE 自動把裸網址變可點）；填充字只留網址
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, txt, url) =>
    LINK_FILLER.test(String(txt).trim()) ? url : `${txt}：${url}`);
  return t.trim();
}

function indentWidth(line) { const m = line.match(/^[ \t]*/); return m ? m[0].replace(/\t/g, '    ').length : 0; }

// Markdown → LINE 友善純文字（靠左、零縮排、◆ 標題分行、・子項目壓平、區塊間空行）。
function markdownToLineText(md) {
  const src = stripSourceFooter(md).split('\n');
  const out = [];
  const pushBlank = () => { if (out.length && out[out.length - 1] !== '') out.push(''); };
  for (const rawLine of src) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') { pushBlank(); continue; }
    const indent = indentWidth(line);
    const stripped = line.replace(/^[ \t]+/, '');
    const heading = stripped.match(/^#{1,6}\s+(.*)$/);
    if (heading) { out.push(inlineClean(heading[1])); continue; }
    const quote = stripped.match(/^>\s?(.*)$/);
    if (quote) { out.push(inlineClean(quote[1])); continue; }
    const item = stripped.match(/^(?:\d+\.|[*\-+])\s+(.*)$/);
    if (item) {
      const body = item[1];
      const topLevel = indent < 2;
      const titled = topLevel && body.match(/^\*\*(.+?)\*\*\s*[：:]?\s*([\s\S]*)$/);
      if (titled) { pushBlank(); out.push('◆ ' + inlineClean(titled[1])); const content = inlineClean(titled[2]); if (content) out.push(content); continue; }
      out.push('・' + inlineClean(body));
      continue;
    }
    out.push(inlineClean(stripped));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { markdownToLineText, stripSourceFooter, inlineClean };
