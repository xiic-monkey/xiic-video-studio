import type { Chapter, SourceDocument } from './types';

const chapterMarker = /^(?:#{1,6}\s+.+|第\s*[0-9一二三四五六七八九十百千万]+\s*[章节卷][^\n]*)$/gm;

function titleFromBlock(block: string, fallback: number) {
  const firstLine = block.trim().split('\n', 1)[0] ?? '';
  const title = firstLine.replace(/^#{1,6}\s*/, '').trim();
  return title || `第 ${fallback} 章`;
}

function excerpt(block: string) {
  const clean = block.replace(/^#{1,6}\s*.+\n?/, '').replace(/\s+/g, ' ').trim();
  return clean.length > 110 ? `${clean.slice(0, 110)}...` : clean || '等待补充章节内容。';
}

function splitUntitledContent(content: string) {
  const paragraphs = content.split(/\n\s*\n/).filter((paragraph) => paragraph.trim());
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current.length > 2_400 && current.length + paragraph.length > 3_400) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = `${current}${current ? '\n\n' : ''}${paragraph}`;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [content];
}

export function splitChapters(content: string): Chapter[] {
  const normalized = content.replace(/\r\n?/g, '\n').trim();
  const matches = [...normalized.matchAll(chapterMarker)];
  const blocks = matches.length
    ? matches.map((match, index) => normalized.slice(match.index, matches[index + 1]?.index ?? normalized.length).trim())
    : splitUntitledContent(normalized);

  return blocks.filter(Boolean).map((block, index) => ({
    id: `chapter_${crypto.randomUUID()}`,
    number: index + 1,
    title: titleFromBlock(block, index + 1),
    summary: excerpt(block),
    content: block,
    wordCount: block.replace(/\s/g, '').length,
    selected: index < 3,
  }));
}

export async function importStoryFile(file: File): Promise<{ source: SourceDocument; chapters: Chapter[] }> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!extension || !['txt', 'md', 'markdown', 'docx'].includes(extension)) {
    throw new Error('仅支持 TXT、Markdown 与 DOCX 文件');
  }

  const body = extension === 'docx'
    ? (await (await import('mammoth')).extractRawText({ arrayBuffer: await file.arrayBuffer() })).value
    : await file.text();
  if (!body.trim()) throw new Error('文件中没有可读取的文本内容');

  const format = extension === 'docx' ? 'docx' : extension === 'txt' ? 'txt' : 'md';
  return {
    source: { id: `source_${crypto.randomUUID()}`, name: file.name, format, importedAt: new Date().toISOString(), body },
    chapters: splitChapters(body),
  };
}
