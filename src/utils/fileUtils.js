/**
 * Convierte un archivo File o Blob en una cadena Base64 
 * para poder almacenarlo en localStorage
 * @param {File} file - El archivo a convertir
 * @returns {Promise<string>} - Promesa que resuelve a la cadena Base64
 */
export const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = error => reject(error);
  });
};

/**
 * Valida si un archivo supera cierto límite de tamaño en MB
 * @param {File} file - Archivo a validar
 * @param {number} maxMb - Tamaño máximo permitido en Megabytes
 * @returns {boolean}
 */
export const validateFileSize = (file, maxMb = 2) => {
  const maxSize = maxMb * 1024 * 1024; // MB a Bytes
  return file.size <= maxSize;
};

/**
 * Helper para verificar si un archivo Base64 es una imagen
 * @param {string} base64String 
 * @returns {boolean}
 */
export const isImageBase64 = (base64String) => {
  if (!base64String) return false;
  return base64String.startsWith('data:image/');
};
