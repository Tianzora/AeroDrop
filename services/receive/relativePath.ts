const CONTROL_CHARACTERS = /[\x00-\x1f]/;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
// Windows 保留设备名不能作为文件名落盘（CON/NUL/COM1…）。macOS/Linux 发来的文件
// 可能合法地带这种名字，所以统一加前缀 `_`，而不是让写盘阶段抛错。
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 接收端唯一的相对路径消毒点。
 * 元数据落盘（manifest）、目录直写（directorySaveSession）、归档条目都必须走这里，
 * 避免同一条 peer 路径在不同入口被解析成不同文件。
 */
export const normalizeRelativePathSegments = (relativePath: string): string[] => {
  const trimmedPath = relativePath.trim();

  if (!trimmedPath) {
    throw new Error('RELATIVE_PATH_EMPTY');
  }

  if (trimmedPath.startsWith('/')) {
    throw new Error('RELATIVE_PATH_ABSOLUTE');
  }

  if (WINDOWS_ABSOLUTE_PATH.test(trimmedPath)) {
    throw new Error('RELATIVE_PATH_ABSOLUTE');
  }

  const segments = trimmedPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new Error('RELATIVE_PATH_EMPTY');
  }

  for (const segment of segments) {
    if (segment === '..') {
      throw new Error('RELATIVE_PATH_TRAVERSAL');
    }
    if (segment === '.') {
      throw new Error('RELATIVE_PATH_DOT_SEGMENT');
    }
    if (CONTROL_CHARACTERS.test(segment)) {
      throw new Error('RELATIVE_PATH_INVALID_SEGMENT');
    }
  }

  return segments.map((segment) =>
    WINDOWS_RESERVED_NAME.test(segment) ? `_${segment}` : segment,
  );
};

export const normalizeRelativePath = (relativePath: string): string =>
  normalizeRelativePathSegments(relativePath).join('/');

export const getRelativePathFileName = (relativePath: string): string => {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? relativePath;
};
