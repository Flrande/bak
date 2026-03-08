import { describe, expect, it } from 'vitest';
import { documentMetadata, isDocumentNode, isShadowRootNode, ownerDocumentForRoot } from '../../packages/extension/src/context-metadata';

describe('context metadata helpers', () => {
  it('treats cross-realm document-like roots as documents', () => {
    const frameDocument = {
      nodeType: 9,
      title: 'Iframe Child',
      location: { href: 'https://example.test/iframe-child.html' }
    } as unknown as Document;
    const fallbackDocument = {
      nodeType: 9,
      title: 'Top Level',
      location: { href: 'https://example.test/iframe-host.html' }
    } as unknown as Document;

    expect(isDocumentNode(frameDocument)).toBe(true);
    expect(ownerDocumentForRoot(frameDocument, fallbackDocument)).toBe(frameDocument);
    expect(documentMetadata(frameDocument, fallbackDocument)).toEqual({
      url: 'https://example.test/iframe-child.html',
      title: 'Iframe Child'
    });
  });

  it('derives metadata from a shadow root host owner document', () => {
    const ownerDocument = {
      nodeType: 9,
      title: 'Nested Shadow',
      location: { href: 'https://example.test/shadow.html' }
    } as unknown as Document;
    const shadowRoot = {
      nodeType: 11,
      host: {
        ownerDocument
      }
    } as unknown as ShadowRoot;
    const fallbackDocument = {
      nodeType: 9,
      title: 'Top Level',
      location: { href: 'https://example.test/index.html' }
    } as unknown as Document;

    expect(isShadowRootNode(shadowRoot)).toBe(true);
    expect(ownerDocumentForRoot(shadowRoot, fallbackDocument)).toBe(ownerDocument);
    expect(documentMetadata(shadowRoot, fallbackDocument)).toEqual({
      url: 'https://example.test/shadow.html',
      title: 'Nested Shadow'
    });
  });

  it('falls back to the provided document for element roots', () => {
    const fallbackDocument = {
      nodeType: 9,
      title: 'Top Level',
      location: { href: 'https://example.test/index.html' }
    } as unknown as Document;
    const elementRoot = {
      nodeType: 1,
      ownerDocument: undefined
    } as unknown as ParentNode;

    expect(ownerDocumentForRoot(elementRoot, fallbackDocument)).toBe(fallbackDocument);
    expect(documentMetadata(elementRoot, fallbackDocument)).toEqual({
      url: 'https://example.test/index.html',
      title: 'Top Level'
    });
  });
});
