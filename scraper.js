const puppeteer = require('puppeteer');

/**
 * Scraper para extraer tareas de Academic Manager (ueh.academic.lat)
 * @param {string} username - Usuario de la plataforma
 * @param {string} password - Contraseña
 * @returns {Promise<Array>} - Lista de tareas encontradas
 */
async function scrapeAcademicManager(username, password) {
  let browser;
  try {
    // Configuración para Render (usa el ejecutable de Chrome si está disponible)
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // 1. Ir al Login
    console.log('Navegando a login...');
    await page.goto('https://ueh.academic.lat/Autenticacion.aspx', { waitUntil: 'networkidle2' });

    // 2. Llenar Credenciales (IDs verificados por el subagente)
    console.log('Ingresando credenciales...');
    await page.waitForSelector('#txtUsuario');
    await page.type('#txtUsuario', username);
    await page.type('#txtContrasenia', password);
    
    // El botón de entrar es un enlace que hace postback
    await Promise.all([
      page.click('#lnkEntrar'),
      page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    // 3. Navegar a Actividades
    console.log('Navegando a actividades...');
    await page.goto('https://ueh.academic.lat/Alumno/AlumnoActividadesClase.aspx', { waitUntil: 'networkidle2' });

    // 4. Extraer eventos del Calendario
    // El calendario parece ser un FullCalendar o similar.
    // Buscamos elementos que parezcan eventos de calendario.
    const tasks = await page.evaluate(() => {
      // Intentamos capturar los bloques del calendario
      const eventElements = document.querySelectorAll('.fc-event, .calendar-event, [class*="event"]');
      const results = [];
      
      eventElements.forEach(el => {
        const title = el.innerText || el.textContent;
        // Intentamos deducir la fecha del contenedor padre (celda del calendario)
        const cell = el.closest('td');
        const dateStr = cell ? cell.getAttribute('data-date') : null;
        
        if (title && title.length > 5) {
          results.push({
            title: title.split('\n')[0].trim(), // Limpiar ruidos
            dueDate: dateStr,
            description: 'Importado de Academic Manager'
          });
        }
      });
      return results;
    });

    console.log(`Scraping completado. Encontradas ${tasks.length} tareas.`);
    return tasks;

  } catch (error) {
    console.error('Error en el scraping:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeAcademicManager };
