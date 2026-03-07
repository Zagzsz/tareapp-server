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
    console.log('Extrayendo tareas y materias...');
    const tasks = await page.evaluate(() => {
      // a. Intentar capturar las materias/áreas de la barra lateral
      const subjects = Array.from(document.querySelectorAll('.Asignaturas li, .sidebar a, .nav-item'))
        .map(el => el.innerText.trim())
        .filter(text => text.length > 3 && !text.includes('\n'));

      // b. Capturar los bloques del calendario
      const eventElements = document.querySelectorAll('.fc-event, .calendar-event, [class*="event"]');
      const results = [];
      
      eventElements.forEach(el => {
        const fullText = (el.innerText || el.textContent).trim();
        
        // Intentar deducir la fecha buscando en ancestros (FullCalendar usa data-date en varios niveles)
        let dateStr = null;
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          if (parent.getAttribute('data-date')) {
            dateStr = parent.getAttribute('data-date');
            break;
          }
          // Si no está en un atributo, tal vez esté en un ID o clase del contenedor
          parent = parent.parentElement;
        }

        // Si aún no hay fecha, intentar buscar en el mismo nivel de la celda (FullCalendar v5+)
        if (!dateStr) {
          const cell = el.closest('td, .fc-daygrid-day');
          if (cell) dateStr = cell.getAttribute('data-date');
        }
        
        if (fullText && fullText.length > 5) {
          // Intentar identificar la materia comparando con la lista lateral
          let category = 'General';
          for (const s of subjects) {
            if (fullText.toLowerCase().includes(s.toLowerCase())) {
              category = s;
              break;
            }
          }

          results.push({
            title: fullText.split('\n')[0].trim(),
            dueDate: dateStr,
            category: category,
            description: `Importado de Academic Manager\nTexto completo: ${fullText.replace(/\n/g, ' ')}`
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
