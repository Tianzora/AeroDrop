
export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  if (bytes < 0) return '0 Bytes';
  if (!isFinite(bytes)) return '---';

  const k = 1024;
  if (bytes < 1) return parseFloat(bytes.toFixed(2)) + ' Bytes';

  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  if (i < 0) return parseFloat(bytes.toFixed(2)) + ' Bytes';
  if (i >= sizes.length) return parseFloat((bytes / Math.pow(k, sizes.length - 1)).toFixed(2)) + ' ' + sizes[sizes.length - 1];

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const generateFileFingerprint = (file: { name: string; size: number; type: string; lastModified: number }): string => {
  const str = `${file.name}|${file.size}|${file.type}|${file.lastModified}`;
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
};
