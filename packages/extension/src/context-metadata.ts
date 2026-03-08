export interface DocumentLike {
  nodeType?: number;
  title?: string;
  location?: {
    href?: string;
  };
}

export interface ShadowRootLike {
  nodeType?: number;
  host?: {
    ownerDocument?: DocumentLike | null;
  };
}

const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

export function isDocumentNode(value: unknown): value is Document {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'nodeType' in value &&
      typeof (value as { nodeType?: unknown }).nodeType === 'number' &&
      (value as { nodeType: number }).nodeType === DOCUMENT_NODE
  );
}

export function isShadowRootNode(value: unknown): value is ShadowRoot {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'nodeType' in value &&
      typeof (value as { nodeType?: unknown }).nodeType === 'number' &&
      (value as { nodeType: number }).nodeType === DOCUMENT_FRAGMENT_NODE &&
      'host' in value
  );
}

export function ownerDocumentForRoot(root: ParentNode, fallbackDocument: Document): Document {
  if (isDocumentNode(root)) {
    return root;
  }
  if (isShadowRootNode(root)) {
    return root.host.ownerDocument ?? fallbackDocument;
  }
  return (root as Node).ownerDocument ?? fallbackDocument;
}

export function documentMetadata(root: ParentNode, fallbackDocument: Document): { url: string; title: string } {
  const ownerDocument = ownerDocumentForRoot(root, fallbackDocument);
  return {
    url: ownerDocument.location?.href ?? fallbackDocument.location?.href ?? '',
    title: ownerDocument.title ?? fallbackDocument.title ?? ''
  };
}
