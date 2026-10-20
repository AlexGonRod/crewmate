export function slugify(value: string, maxLength = 40): string {
  const normalized = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const fallback = normalized || 'task';
  return fallback.slice(0, maxLength).replace(/-+$/g, '') || 'task';
}
