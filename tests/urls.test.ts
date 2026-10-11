import { describe, it, expect } from 'vitest';
import { cssUrls, formatHint, imageName, isSupportedPage, normalizeUrl } from '../lib/urls';

describe('URL rules', () => {
  it('resolves a relative path against document base', () =>
    expect(normalizeUrl('../image.webp', 'https://shop.test/assets/gallery/')).toBe(
      'https://shop.test/assets/image.webp',
    ));
  it('resolves protocol relative URLs', () =>
    expect(normalizeUrl('//cdn.test/a.png', 'https://shop.test/')).toBe('https://cdn.test/a.png'));
  it('preserves signed parameters, order and fragments', () =>
    expect(normalizeUrl('/a.svg?size=200&sig=ABC%2F#sprite', 'https://shop.test/')).toBe(
      'https://shop.test/a.svg?size=200&sig=ABC%2F#sprite',
    ));
  it.each([
    '',
    ' ',
    'data:image/png;base64,abc',
    'blob:https://shop.test/1',
    'javascript:alert(1)',
    'file:///tmp/a.png',
    'https://[invalid',
  ])('rejects %s', (value) => expect(normalizeUrl(value, 'https://shop.test')).toBeNull());
  it('rejects oversized URLs instead of truncating', () =>
    expect(
      normalizeUrl('https://shop.test/' + 'x'.repeat(16_384), 'https://shop.test'),
    ).toBeNull());
  it('handles encoded filenames and alt fallback', () => {
    expect(imageName('https://a.test/%E5%B1%B1.webp')).toBe('山.webp');
    expect(imageName('https://a.test/', '山丘')).toBe('山丘');
  });
  it('marks only known suffixes as format hints', () => {
    expect(formatHint('https://a.test/image.AVIF?x=.jpg')).toBe('AVIF');
    expect(formatHint('https://a.test/image?id=1')).toBe('未知');
  });
  it('rejects restricted pages', () => {
    expect(isSupportedPage('https://a.test')).toBe(true);
    for (const url of [
      'chrome://settings',
      'file:///a.html',
      'https://chromewebstore.google.com/detail/test',
      'https://a.test/a.PDF',
    ])
      expect(isSupportedPage(url)).toBe(false);
  });
});
describe('CSS tokenizer', () => {
  it('extracts layers without splitting commas inside URLs', () =>
    expect(
      cssUrls('linear-gradient(red, blue), url("https://a.test/img?q=a,b"), url(b.png)'),
    ).toEqual(['https://a.test/img?q=a,b', 'b.png']));
  it('preserves parentheses in quoted URLs', () =>
    expect(cssUrls("url('image(2).svg')")).toEqual(['image(2).svg']));
  it('decodes escapes, hex escapes and escaped whitespace', () =>
    expect(cssUrls('url("a\\22 b.svg"), url(a\\)b.svg), url(a\\ b.svg)')).toEqual([
      'a"b.svg',
      'a)b.svg',
      'a b.svg',
    ]));
  it('does not discover functions embedded in strings', () =>
    expect(cssUrls('"url(fake.svg)", url(real.svg)')).toEqual(['real.svg']));
  it('ignores empty or incomplete functions', () =>
    expect(cssUrls('none, url(), url("incomplete"')).toEqual([]));
  it('skips unsupported image-set variants while retaining other layers', () =>
    expect(cssUrls('image-set(url("a.svg") 1x, url("b.svg") 2x),url(c.svg)')).toEqual(['c.svg']));
});
