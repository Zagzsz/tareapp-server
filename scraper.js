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
    console.log('Detectando eventos en el calendario...');
    const eventSelectors = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.fc-event, .calendar-event, [class*="event"]'))
        .map((el, i) => {
          // Asignar un ID temporal si no tiene para poder hacer click exacto
          if (!el.id) el.id = `temp-event-${i}`;
          return `#${el.id}`;
        });
    });

    const tasks = [];
    console.log(`Procesando ${eventSelectors.length} eventos detalladamente...`);

    // Procesamos solo los primeros 15 para no saturar el servidor/tiempo en esta fase de prueba
    for (const selector of eventSelectors.slice(0, 15)) {
      try {
        await page.click(selector);
        // Esperar a que el modal aparezca (suelen tener ids como 'modal', 'dialog' o clases descriptivas)
        await page.waitForSelector('.modal-content, #DetalleActividad, .ui-dialog', { timeout: 5000 });
        await new Promise(r => setTimeout(r, 500)); // Delay para animación

        const detail = await page.evaluate(() => {
          const modal = document.querySelector('.modal-content, #DetalleActividad, .ui-dialog');
          if (!modal) return null;

          // Según la captura del usuario:
          // Izquierda arriba: Fecha publicación, Asignatura, Título (grande)
          // Derecha: Fecha y hora de entrega exacta
          
          const fullText = modal.innerText || "";
          const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          
          // Intentar capturar la asignatura (suele estar arriba del título)
          let category = "General";
          const asignaturaEl = modal.querySelector('.asignatura, [class*="Asignatura"], h5');
          if (asignaturaEl) category = asignaturaEl.innerText.trim();

          // Título grande
          let title = lines[0]; 
          const titleEl = modal.querySelector('h3, h2, .titulo');
          if (titleEl) title = titleEl.innerText.trim();

          // Fecha y hora de entrega (extrayendo del texto con Regex: DD/MM/YYYY HH:mm)
          const dateRegex = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/;
          const match = fullText.match(dateRegex);
          let dueDate = null;
          if (match) {
            const [_, date, time] = match;
            // Convertir DD/MM/YYYY a YYYY-MM-DD para la DB
            const [d, m, y] = date.split('/');
            dueDate = `${y}-${m}-${d} ${time}:00`;
          }

          return { title, category, dueDate, description: `Sincronizado de Academic Manager\n${fullText.substring(0, 200)}...` };
        });

        if (detail) tasks.push(detail);

        // Cerrar el modal (Escape o botón de cierre)
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 300));

      } catch (err) {
        console.warn(`Error procesando evento ${selector}:`, err.message);
        // Intentar cerrar si algo falló
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    console.log(`Scraping profundo completado. Encontradas ${tasks.length} tareas con detalle.`);
    return tasks;

  } catch (error) {
    console.error('Error en el scraping:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeAcademicManager };
