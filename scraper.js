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
    // Aumentar el timeout por defecto y usar domcontentloaded que es más rápido
    await page.setDefaultNavigationTimeout(60000); 
    await page.goto('https://ueh.academic.lat/Autenticacion.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 2. Llenar Credenciales (IDs verificados por el subagente)
    console.log('Ingresando credenciales...');
    await page.waitForSelector('#txtUsuario', { timeout: 30000 });
    await page.type('#txtUsuario', username);
    await page.type('#txtContrasenia', password);
    
    // El botón de entrar es un enlace que hace postback
    await Promise.all([
      page.click('#lnkEntrar'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 })
    ]);

    // 3. Navegar a Actividades
    console.log('Navegando a actividades...');
    await page.goto('https://ueh.academic.lat/Alumno/AlumnoActividadesClase.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 4. Extraer eventos del Calendario
    console.log('Detectando eventos en el calendario...');
    const eventSelectors = await page.evaluate(() => {
      // Los eventos suelen tener clases fc-event o similares en FullCalendar
      return Array.from(document.querySelectorAll('.fc-event, .calendar-event'))
        .map((el, i) => {
          if (!el.id) el.id = `evt-${Date.now()}-${i}`;
          return `#${el.id}`;
        });
    });

    const tasks = [];
    console.log(`Procesando ${eventSelectors.length} eventos detalladamente...`);

    for (const selector of eventSelectors) {
      try {
        await page.click(selector);
        // Esperar el modal específico de esta plataforma
        await page.waitForSelector('#ctl00_cphContenidoPrincipal_pnlDetalleActividad, .modal-content', { timeout: 5000 });
        await new Promise(r => setTimeout(r, 600));

        const detail = await page.evaluate(() => {
          // Intentar capturar el panel de detalle por su ID de ASP.NET
          const modal = document.querySelector('[id*="pnlDetalleActividad"]') || document.querySelector('.modal-content');
          if (!modal) return null;

          const fullText = modal.innerText || "";
          
          // Asignatura (ubicada arriba del título)
          let category = "General";
          const asignaturaEl = modal.querySelector('h5') || modal.querySelector('[class*="Asignatura"]');
          if (asignaturaEl) category = asignaturaEl.innerText.trim();

          // Título (el texto más grande en el cuerpo del modal)
          let title = "Tarea sin título";
          const titleEl = modal.querySelector('h2, h3, .titulo');
          if (titleEl) title = titleEl.innerText.trim();

          // Fecha de entrega (estilo: 08/03/2026 18:20 hrs.)
          // Buscamos específicamente el patrón de fecha y hora
          const dateRegex = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/;
          const match = fullText.match(dateRegex);
          let dueDate = null;
          if (match) {
            const [_, date, time] = match;
            const [d, m, y] = date.split('/');
            dueDate = `${y}-${m}-${d} ${time}:00`;
          }

          return { 
            title, 
            category, 
            dueDate, 
            description: `Importado de Academic Manager\n${fullText.substring(0, 300)}` 
          };
        });

        if (detail) tasks.push(detail);

        // Cerrar usando el ID de ASP.NET verificado
        const closeBtn = await page.$('#ctl00_cphContenidoPrincipal_lnkCerrarDetalleActividad');
        if (closeBtn) {
          await closeBtn.click();
        } else {
          await page.keyboard.press('Escape');
        }
        
        await new Promise(r => setTimeout(r, 400));

      } catch (err) {
        console.warn(`Error en tarea con selector ${selector}:`, err.message);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    console.log(`Sincronización terminada. ${tasks.length} tareas procesadas con éxito.`);
    return tasks;

  } catch (error) {
    console.error('Error en el scraping:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeAcademicManager };
