// Genera agentes a partir de datasets públicos de diálogo y del catálogo public-apis.
//
//   npm run build:datasets            descarga lo necesario, genera y borra los archivos grandes
//   npm run build:datasets -- --keep  conserva la caché en data/datasets
//
// De cada fuente se extrae:
//   · Esquemas de intenciones y slots (SGD, MultiWOZ 2.2, Taskmaster-2) → temas guiados
//     con una pregunta por cada dato obligatorio.
//   · Primeras frases reales de usuario por intención → frases disparadoras.
//   · Conversaciones de ejemplo → conocimiento (estilo y forma de resolver).
//   · Políticas de τ²-bench (aerolínea, tienda, telecom) → conocimiento literal.
//   · Bitext (27 intenciones de atención al cliente) → respuestas modelo y temas.
//   · public-apis (sin clave, HTTPS) → catálogo y acciones HTTP reales.
// No es un ajuste fino de un modelo: el "entrenamiento" es el contexto que el agente
// recibe (temas + base de conocimiento + acciones).
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, agentDir, saveAgent } from '../src/store.ts';
import type { ActionDef, AgentDef, KnowledgeSource, Step, Topic } from '../src/types.ts';

const CACHE = join(ROOT, 'data', 'datasets');
const KEEP = process.argv.includes('--keep');
const gh = (repo: string, branch: string, path: string) => `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;

const FILES = {
  sgdSchema: { url: gh('google-research-datasets/dstc8-schema-guided-dialogue', 'master', 'train/schema.json'), big: false },
  sgdDlg1: { url: gh('google-research-datasets/dstc8-schema-guided-dialogue', 'master', 'train/dialogues_001.json'), big: true },
  sgdDlg2: { url: gh('google-research-datasets/dstc8-schema-guided-dialogue', 'master', 'train/dialogues_002.json'), big: true },
  mwSchema: { url: gh('budzianowski/multiwoz', 'master', 'data/MultiWOZ_2.2/schema.json'), big: false },
  mwDlg1: { url: gh('budzianowski/multiwoz', 'master', 'data/MultiWOZ_2.2/train/dialogues_001.json'), big: true },
  tmFood: { url: gh('google-research-datasets/Taskmaster', 'master', 'TM-2-2020/data/food-ordering.json'), big: true },
  ...Object.fromEntries(
    ['flights', 'food-ordering', 'hotels', 'movies', 'music', 'restaurant-search', 'sports'].map((d) => [
      `tmOnt_${d}`,
      { url: gh('google-research-datasets/Taskmaster', 'master', `TM-2-2020/ontology/${d}.json`), big: false },
    ]),
  ),
  tauAirline: { url: gh('sierra-research/tau2-bench', 'main', 'data/tau2/domains/airline/policy.md'), big: false },
  tauRetail: { url: gh('sierra-research/tau2-bench', 'main', 'data/tau2/domains/retail/policy.md'), big: false },
  tauTelecom: { url: gh('sierra-research/tau2-bench', 'main', 'data/tau2/domains/telecom/main_policy.md'), big: false },
  publicApis: { url: gh('public-apis/public-apis', 'master', 'README.md'), big: false },
  bitext: {
    url: 'https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset/resolve/main/Bitext_Sample_Customer_Support_Training_Dataset_27K_responses-v11.csv',
    big: true,
  },
} as Record<string, { url: string; big: boolean }>;

const SOURCES_MD = `| Fuente | Licencia | Uso |
|---|---|---|
| [Schema-Guided Dialogue (DSTC8)](https://github.com/google-research-datasets/dstc8-schema-guided-dialogue) | CC BY-SA 4.0 | Intenciones, slots, frases y ejemplos |
| [MultiWOZ 2.2](https://github.com/budzianowski/multiwoz) | MIT | Intenciones, slots, frases y ejemplos |
| [Taskmaster-2](https://github.com/google-research-datasets/Taskmaster) | CC BY 4.0 | Ontologías y pedidos de comida |
| [τ²-bench](https://github.com/sierra-research/tau2-bench) | MIT | Políticas de aerolínea, tienda y telecom |
| [Bitext Customer Support](https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset) | CDLA-Sharing 1.0 | Intenciones y respuestas de soporte |
| [public-apis](https://github.com/public-apis/public-apis) | MIT | Catálogo de APIs y acciones |`;

// ---------- descarga ----------

async function fetchTo(name: string): Promise<string> {
  const f = FILES[name];
  const path = join(CACHE, `${name}${f.url.endsWith('.csv') ? '.csv' : f.url.endsWith('.md') ? '.md' : '.json'}`);
  if (!existsSync(path)) {
    process.stdout.write(`  ↓ ${name} … `);
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    console.log('ok');
  }
  return path;
}
const readJson = async <T>(name: string): Promise<T> => JSON.parse(await readFile(await fetchTo(name), 'utf8')) as T;
const readText = async (name: string): Promise<string> => readFile(await fetchTo(name), 'utf8');

// ---------- utilidades ----------

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const camel = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2');

// CSV con comillas y saltos de línea dentro de los campos
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- formato SGD / MultiWOZ 2.2 ----------

interface SgdSlot { name: string; description: string; is_categorical?: boolean; possible_values?: string[] }
interface SgdIntent { name: string; description: string; required_slots: string[]; optional_slots?: Record<string, string> | string[]; is_transactional?: boolean }
interface SgdService { service_name: string; description: string; slots: SgdSlot[]; intents: SgdIntent[] }
interface SgdDialogue { dialogue_id: string; services: string[]; turns: { speaker: string; utterance: string; frames: { service: string; state?: { active_intent: string } }[] }[] }

// Frase con la que el usuario ABRE el diálogo, por intención activa ("servicio::intención").
// Solo el primer turno: las de mitad de conversación ("Yes, at 7pm") encajarían con
// casi cualquier mensaje y harían saltar el tema sin motivo.
function triggersByIntent(dialogues: SgdDialogue[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of dialogues) {
    const first = d.turns.find((t) => t.speaker === 'USER');
    if (!first) continue;
    const u = clean(first.utterance);
    if (u.length < 15 || u.length > 120 || u.split(' ').length < 4) continue;
    for (const f of first.frames) {
      const intent = f.state?.active_intent;
      if (!intent || intent === 'NONE') continue;
      const key = `${f.service}::${intent}`;
      (out.get(key) ?? out.set(key, []).get(key)!).push(u);
    }
  }
  return out;
}

function transcript(turns: { speaker: string; text: string }[], max = 10): string {
  return turns
    .slice(0, max)
    .map((t) => `${/user/i.test(t.speaker) ? 'Usuario' : 'Agente'}: ${clean(t.text)}`)
    .join('\n');
}

// ---------- español: nombres de intenciones y preguntas por slot ----------

const INTENT_ES: Record<string, string> = {
  FindRestaurants: 'Buscar restaurantes', ReserveRestaurant: 'Reservar mesa', find_restaurant: 'Buscar restaurantes', book_restaurant: 'Reservar mesa',
  SearchHotel: 'Buscar hotel', ReserveHotel: 'Reservar hotel', find_hotel: 'Buscar hotel', book_hotel: 'Reservar hotel',
  SearchOnewayFlight: 'Buscar vuelo de ida', SearchRoundtripFlights: 'Buscar vuelo de ida y vuelta', ReserveOnewayFlight: 'Reservar vuelo de ida', ReserveRoundtripFlights: 'Reservar vuelo de ida y vuelta',
  FindBus: 'Buscar autobús', BuyBusTicket: 'Comprar billete de autobús', FindTrains: 'Buscar trenes', GetTrainTickets: 'Comprar billete de tren',
  find_train: 'Buscar trenes', book_train: 'Comprar billete de tren', book_taxi: 'Pedir taxi', find_taxi: 'Pedir taxi', GetRide: 'Pedir un viaje', GetCarsAvailable: 'Buscar coche de alquiler', ReserveCar: 'Reservar coche de alquiler',
  FindEvents: 'Buscar eventos', BuyEventTickets: 'Comprar entradas', FindMovies: 'Buscar películas', GetTimesForMovie: 'Horarios de cine', BuyMovieTickets: 'Comprar entradas de cine', PlayMovie: 'Reproducir película',
  LookupMusic: 'Buscar música', PlaySong: 'Reproducir canción', LookupSong: 'Buscar canción', PlayMedia: 'Reproducir', FindAttractions: 'Buscar atracciones', find_attraction: 'Buscar atracciones',
  BookAppointment: 'Pedir cita', FindProvider: 'Buscar profesional', CheckBalance: 'Consultar saldo', TransferMoney: 'Transferir dinero', MakePayment: 'Hacer un pago', RequestPayment: 'Solicitar un pago',
  AddEvent: 'Añadir al calendario', GetEvents: 'Ver eventos del calendario', GetAvailableTime: 'Ver huecos libres', AddAlarm: 'Poner alarma', GetAlarms: 'Ver alarmas',
  FindApartment: 'Buscar piso', FindHomeByArea: 'Buscar vivienda por zona', ScheduleVisit: 'Agendar visita', GetWeather: 'Consultar el tiempo', ShareLocation: 'Compartir ubicación',
};

const SLOT_Q: Record<string, string> = {
  restaurant_name: '¿En qué restaurante?', name: '¿Cómo se llama el sitio que buscas?', city: '¿En qué ciudad?', location: '¿En qué ciudad o zona?', area: '¿En qué zona?',
  date: '¿Para qué fecha?', time: '¿A qué hora?', day: '¿Qué día?', party_size: '¿Para cuántas personas?', number_of_seats: '¿Para cuántas personas?', people: '¿Para cuántas personas?', bookpeople: '¿Para cuántas personas?',
  bookday: '¿Qué día?', booktime: '¿A qué hora?', bookstay: '¿Cuántas noches?', stay: '¿Cuántas noches?', cuisine: '¿Qué tipo de comida prefieres?', category: '¿Qué tipo de cocina?', food: '¿Qué tipo de comida?',
  price_range: '¿Qué rango de precio buscas?', pricerange: '¿Qué rango de precio buscas?', hotel_name: '¿Qué hotel?', place_name: '¿Qué lugar?', check_in_date: '¿Qué día entras?', check_out_date: '¿Qué día sales?',
  number_of_rooms: '¿Cuántas habitaciones?', number_of_days: '¿Cuántos días?', star_rating: '¿De cuántas estrellas?', stars: '¿De cuántas estrellas?', type: '¿Qué tipo de alojamiento?', internet: '¿Necesitas wifi?', parking: '¿Necesitas aparcamiento?',
  origin: '¿Desde dónde sales?', origin_city: '¿Desde qué ciudad sales?', from: '¿Desde dónde sales?', from_location: '¿Desde dónde sales?', from_city: '¿Desde qué ciudad sales?', departure: '¿Desde dónde sales?',
  destination: '¿A dónde vas?', destination_city: '¿A qué ciudad vas?', to: '¿A dónde vas?', to_location: '¿A dónde vas?', to_city: '¿A qué ciudad vas?',
  departure_date: '¿Qué día sales?', leaving_date: '¿Qué día sales?', return_date: '¿Qué día vuelves?', departure_time: '¿A qué hora sales?', leaving_time: '¿A qué hora sales?', leaveat: '¿A partir de qué hora quieres salir?', arriveby: '¿A qué hora necesitas llegar?',
  passengers: '¿Cuántos pasajeros?', number_of_riders: '¿Cuántos viajeros?', number_of_adults: '¿Cuántos adultos?', group_size: '¿Cuántas personas?', seating_class: '¿En qué clase?', airlines: '¿Alguna aerolínea preferida?',
  pickup_location: '¿Dónde lo recoges?', pickup_date: '¿Qué día lo recoges?', pickup_time: '¿A qué hora lo recoges?', dropoff_date: '¿Qué día lo devuelves?', car_type: '¿Qué tipo de coche?', ride_type: '¿Qué tipo de viaje?',
  event_name: '¿Qué evento?', event_type: '¿Qué tipo de evento?', event_date: '¿Para qué fecha?', event_location: '¿Dónde es?', event_time: '¿A qué hora?', number_of_tickets: '¿Cuántas entradas?',
  movie_name: '¿Qué película?', title: '¿Qué título?', show_date: '¿Qué día?', show_time: '¿A qué hora?', theater_name: '¿En qué cine?', show_type: '¿Qué formato (2D, 3D, IMAX)?', genre: '¿Qué género?',
  song_name: '¿Qué canción?', artist: '¿De qué artista?', album: '¿Qué álbum?', playback_device: '¿En qué dispositivo?', subtitle_language: '¿Subtítulos en qué idioma?',
  appointment_date: '¿Para qué día quieres la cita?', appointment_time: '¿A qué hora?', stylist_name: '¿Con qué estilista?', doctor_name: '¿Con qué médico?', dentist_name: '¿Con qué dentista?', therapist_name: '¿Con qué terapeuta?',
  account_type: '¿Qué tipo de cuenta (corriente o ahorro)?', amount: '¿Qué importe?', recipient_account_name: '¿A quién se lo envías?', receiver: '¿A quién?', recipient_name: '¿A quién?', payment_method: '¿Con qué método de pago?', private_visibility: '¿Quieres que sea privado?',
  event_title: '¿Cómo se llama el evento?', alarm_time: '¿A qué hora pongo la alarma?', new_alarm_time: '¿A qué hora pongo la alarma?', new_alarm_name: '¿Qué nombre le pongo?',
  property_name: '¿Qué vivienda?', visit_date: '¿Qué día quieres visitarla?', number_of_beds: '¿Cuántas habitaciones?', number_of_baths: '¿Cuántos baños?', intent: '¿Quieres alquilar o comprar?',
  attraction_name: '¿Qué atracción?', travelers: '¿Cuántos viajeros?', outbound_departure_time: '¿A qué hora quieres salir a la ida?', inbound_departure_time: '¿A qué hora quieres salir a la vuelta?',
  pickup_city: '¿En qué ciudad recoges el coche?', shared_ride: '¿Te importa compartir el viaje con otros pasajeros?', city_of_event: '¿En qué ciudad?', where_to: '¿En qué zona buscas vivienda?', department: '¿Qué departamento?', postcode: '¿Código postal?', phone: '¿Teléfono de contacto?',
};
const SLOT_LABEL = (s: string) => (SLOT_Q[s] ?? s).replace(/^¿|\?$/g, '').replace(/^(En|A|Para|De|Con|Desde) /, '').toLowerCase();

const varName = (slot: string) => slot.replace(/^[a-z]+-/, '').replace(/[^a-zA-Z0-9_]/g, '_');

function slotQuestion(slot: SgdSlot | undefined, raw: string): Step {
  const v = varName(raw);
  const prompt = SLOT_Q[v] ?? `Indícame ${slot?.description ?? v.replace(/_/g, ' ')}.`;
  const values = slot?.is_categorical ? (slot.possible_values ?? []).filter((x) => x && x !== 'dontcare') : [];
  return { type: 'question', prompt, variable: v, ...(values.length >= 2 && values.length <= 8 ? { options: values } : {}) };
}

function intentTopic(service: SgdService, intent: SgdIntent, triggers: string[], esTriggers: string[] = []): Topic {
  const slots = new Map(service.slots.map((s) => [s.name, s]));
  // Sin datos obligatorios (p. ej. búsquedas de MultiWOZ): hasta 3 opcionales como preguntas
  const optional = Array.isArray(intent.optional_slots) ? intent.optional_slots : Object.keys(intent.optional_slots ?? {});
  const required = intent.required_slots?.length ? intent.required_slots : optional.slice(0, 3);
  const steps: Step[] = required.map((r) => slotQuestion(slots.get(r), r));
  const summary = required.map((r) => `${SLOT_LABEL(varName(r))}: {{${varName(r)}}}`).join(' · ');
  const title = INTENT_ES[intent.name] ?? camel(intent.name).replace(/_/g, ' ');
  steps.push({
    type: 'message',
    text: intent.is_transactional || /book|reserve|buy|make|transfer|add|schedule|get_?ride|request/i.test(intent.name)
      ? `Perfecto. Resumen de tu solicitud (${title.toLowerCase()}): ${summary || 'sin datos adicionales'}. La dejo registrada y te confirmo en breve.`
      : `Busco opciones con estos datos: ${summary || 'sin filtros'}. ¿Quieres que te recomiende alguna?`,
  });
  return {
    name: title,
    description: clean(intent.description),
    triggers: uniq([...esTriggers, ...triggers]).slice(0, 14),
    steps,
  };
}

function schemaMarkdown(services: SgdService[], source: string): string {
  return services
    .map((s) => {
      const intents = s.intents.map((i) => `- **${INTENT_ES[i.name] ?? camel(i.name)}** (\`${i.name}\`): ${clean(i.description)}. Datos obligatorios: ${(i.required_slots ?? []).map((r) => SLOT_LABEL(varName(r))).join(', ') || '—'}.`).join('\n');
      const slots = s.slots.map((sl) => `- \`${varName(sl.name)}\`: ${clean(sl.description)}${sl.is_categorical && sl.possible_values?.length ? ` (valores: ${sl.possible_values.slice(0, 10).join(', ')})` : ''}`).join('\n');
      return `### ${s.service_name} — ${clean(s.description)}\n\nFuente: ${source}\n\nIntenciones:\n${intents}\n\nDatos (slots):\n${slots}`;
    })
    .join('\n\n');
}

// ---------- dominios ----------

interface DomainSpec {
  id: string;
  name: string;
  icon: string;
  category: AgentDef['category'];
  description: string;
  instructions: string;
  greeting: string;
  sgd: RegExp; // servicios SGD
  mw: string[]; // servicios MultiWOZ
  tmOntologies?: string[];
  esTriggers?: Record<string, string[]>; // por nombre de intención
}

const BASE_RULES = `
Reglas:
- Responde en el idioma del usuario (por defecto, español), breve y claro.
- Pide un dato cada vez. Si el usuario ya lo dio, no lo vuelvas a pedir.
- Antes de confirmar una reserva o compra, resume los datos y pide confirmación.
- No inventes disponibilidad, precios ni números de reserva: si no tienes el dato, dilo.
- Usa la base de conocimiento: el esquema de datos y las conversaciones de ejemplo muestran cómo resolver cada caso.`;

const DOMAINS: DomainSpec[] = [
  {
    id: 'reservas-restaurantes', name: 'Reservas de restaurantes', icon: '🍽️',
    category: { function: 'Servicio al Cliente', industry: 'Venta minorista', useCase: 'Reservas' },
    description: 'Busca restaurantes, reserva mesa y toma pedidos de comida. Entrenado con SGD, MultiWOZ 2.2 y Taskmaster-2.',
    instructions: `Eres el asistente de reservas de restaurantes. Ayudas a encontrar restaurante (zona, tipo de comida, precio), reservar mesa (día, hora, personas) y hacer pedidos de comida para llevar o a domicilio.${BASE_RULES}`,
    greeting: '¡Hola! ¿Buscas restaurante, quieres reservar mesa o hacer un pedido?',
    sgd: /^Restaurants_/, mw: ['restaurant'], tmOntologies: ['restaurant-search', 'food-ordering'],
    esTriggers: {
      FindRestaurants: ['buscar restaurante', 'recomiéndame un restaurante', 'dónde puedo cenar', 'busco un sitio para comer'],
      ReserveRestaurant: ['reservar mesa', 'quiero reservar una mesa', 'hacer una reserva en un restaurante'],
      find_restaurant: ['restaurante barato en el centro', 'busco restaurante italiano'],
      book_restaurant: ['reserva para cenar', 'reservar para esta noche'],
    },
  },
  {
    id: 'reservas-hoteles', name: 'Reservas de hoteles', icon: '🏨',
    category: { function: 'Servicio al Cliente', industry: 'Medios y entretenimiento', useCase: 'Reservas' },
    description: 'Busca alojamiento y gestiona reservas de hotel. Entrenado con SGD, MultiWOZ 2.2 y Taskmaster-2.',
    instructions: `Eres el asistente de reservas de hotel. Ayudas a encontrar alojamiento (ciudad, zona, estrellas, precio, wifi, aparcamiento) y a reservar (fecha de entrada, noches, personas, habitaciones).${BASE_RULES}`,
    greeting: '¡Hola! ¿En qué ciudad buscas alojamiento?',
    sgd: /^Hotels_/, mw: ['hotel'], tmOntologies: ['hotels'],
    esTriggers: {
      SearchHotel: ['buscar hotel', 'busco hotel', 'necesito alojamiento'],
      ReserveHotel: ['reservar hotel', 'quiero reservar una habitación'],
      find_hotel: ['hotel con wifi y parking', 'busco un hotel barato'],
      book_hotel: ['reserva de hotel para el fin de semana'],
    },
  },
  {
    id: 'transporte-y-viajes', name: 'Transporte y viajes', icon: '✈️',
    category: { function: 'Operaciones', industry: 'Venta minorista', useCase: 'Viajes' },
    description: 'Vuelos, trenes, autobuses, taxis, viajes compartidos y alquiler de coches. Entrenado con SGD, MultiWOZ 2.2 y Taskmaster-2.',
    instructions: `Eres el asistente de viajes y transporte. Ayudas a buscar y reservar vuelos, trenes, autobuses, taxis, viajes compartidos y coches de alquiler: origen, destino, fechas, horas y pasajeros.${BASE_RULES}`,
    greeting: '¡Hola! ¿A dónde quieres ir y cuándo?',
    sgd: /^(Flights|Buses|Trains|RideSharing|RentalCars)_/, mw: ['train', 'taxi', 'bus'], tmOntologies: ['flights'],
    esTriggers: {
      SearchOnewayFlight: ['buscar vuelo', 'vuelo de ida', 'busco un vuelo'],
      SearchRoundtripFlights: ['vuelo de ida y vuelta'],
      FindTrains: ['buscar tren', 'horarios de tren'],
      FindBus: ['buscar autobús', 'bus a otra ciudad'],
      GetRide: ['pedir un taxi', 'necesito un coche que me lleve'],
      book_taxi: ['pedir taxi', 'reservar un taxi'],
      GetCarsAvailable: ['alquilar un coche', 'coche de alquiler'],
    },
  },
  {
    id: 'ocio-y-eventos', name: 'Ocio y eventos', icon: '🎟️',
    category: { industry: 'Medios y entretenimiento', useCase: 'Entradas y recomendaciones' },
    description: 'Eventos, conciertos, cine, música y lugares de interés. Entrenado con SGD, MultiWOZ 2.2 y Taskmaster-2.',
    instructions: `Eres el asistente de ocio. Recomiendas eventos, conciertos, películas, música y lugares que visitar, y ayudas a comprar entradas.${BASE_RULES}`,
    greeting: '¡Hola! ¿Te apetece un concierto, cine o algún plan?',
    sgd: /^(Events|Movies|Music|Media|Travel)_/, mw: ['attraction'], tmOntologies: ['movies', 'music', 'sports'],
    esTriggers: {
      FindEvents: ['buscar conciertos', 'qué eventos hay', 'planes para el fin de semana'],
      BuyEventTickets: ['comprar entradas', 'quiero entradas para el concierto'],
      FindMovies: ['qué películas hay', 'buscar película'],
      GetTimesForMovie: ['horarios del cine'],
      FindAttractions: ['qué visitar', 'lugares turísticos'],
    },
  },
  {
    id: 'servicios-y-citas', name: 'Citas, banca y agenda', icon: '📅',
    category: { function: 'Oficinas ejecutivas', industry: 'Servicios financieros', useCase: 'Citas y gestiones' },
    description: 'Citas (peluquería, médico, dentista), banca y pagos, calendario, alarmas y visitas a viviendas. Entrenado con SGD.',
    instructions: `Eres un asistente personal. Gestionas citas con profesionales, consultas de saldo, transferencias y pagos, eventos del calendario, alarmas y visitas a viviendas. Nunca pidas contraseñas, PIN ni códigos de verificación.${BASE_RULES}`,
    greeting: '¡Hola! ¿Quieres pedir una cita, hacer una gestión bancaria o organizar tu agenda?',
    sgd: /^(Services|Banks|Payment|Calendar|Alarm|Homes)_/, mw: ['hospital', 'police'],
    esTriggers: {
      BookAppointment: ['pedir cita', 'reservar cita', 'quiero una cita'],
      FindProvider: ['buscar dentista', 'buscar peluquería', 'buscar médico'],
      CheckBalance: ['consultar saldo', 'cuánto dinero tengo'],
      TransferMoney: ['hacer una transferencia', 'enviar dinero'],
      AddEvent: ['añadir evento al calendario'],
      AddAlarm: ['poner una alarma', 'despiértame'],
    },
  },
];

// ---------- construcción de agentes ----------

async function writeKnowledge(id: string, files: Record<string, string>): Promise<KnowledgeSource[]> {
  const dir = join(agentDir(id), 'knowledge');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const out: KnowledgeSource[] = [];
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
    out.push({ type: 'file', name: name.replace(/\.md$/, '').replace(/-/g, ' '), path: `knowledge/${name}` });
  }
  return out;
}

async function buildDomainAgents(ctx: {
  sgd: SgdService[]; mw: SgdService[]; sgdTriggers: Map<string, string[]>; mwTriggers: Map<string, string[]>;
  sgdDialogues: SgdDialogue[]; mwDialogues: SgdDialogue[]; tmOnt: Record<string, unknown>; tmFood: { utterances: { speaker: string; text: string }[] }[];
}): Promise<AgentDef[]> {
  const agents: AgentDef[] = [];
  for (const d of DOMAINS) {
    const sgdServices = ctx.sgd.filter((s) => d.sgd.test(s.service_name));
    const mwServices = ctx.mw.filter((s) => d.mw.includes(s.service_name));
    const topics = new Map<string, Topic>();

    // Una intención = un tema; si varios servicios la comparten, se unen las frases
    for (const [services, trig] of [[sgdServices, ctx.sgdTriggers], [mwServices, ctx.mwTriggers]] as const) {
      for (const s of services) {
        for (const intent of s.intents) {
          const t = intentTopic(s, intent, trig.get(`${s.service_name}::${intent.name}`)?.slice(0, 10) ?? [], d.esTriggers?.[intent.name]);
          const prev = topics.get(t.name);
          if (prev) prev.triggers = uniq([...prev.triggers, ...t.triggers]).slice(0, 16);
          else topics.set(t.name, t);
        }
      }
    }
    // Pedidos de comida (Taskmaster-2) para el agente de restaurantes
    if (d.id === 'reservas-restaurantes') {
      const firsts = ctx.tmFood.map((c) => c.utterances.find((u) => u.speaker === 'USER')?.text ?? '').map(clean).filter((u) => u.length > 12 && u.length < 110 && /order|food|pizza|takeout|take out|deliver|pick ?up|hungry|eat|burger|sandwich/i.test(u));
      topics.set('Pedir comida', {
        name: 'Pedir comida',
        description: 'Pedido de comida para llevar o a domicilio',
        triggers: uniq(['pedir comida', 'quiero hacer un pedido', 'pedido a domicilio', 'comida para llevar', ...firsts.slice(0, 10)]),
        steps: [
          { type: 'question', prompt: '¿De qué restaurante quieres pedir?', variable: 'restaurante' },
          { type: 'question', prompt: '¿Qué te apetece pedir?', variable: 'pedido' },
          { type: 'question', prompt: '¿Para llevar o a domicilio?', variable: 'entrega', options: ['Para llevar', 'A domicilio'] },
          { type: 'condition', if: 'entrega == "A domicilio"', then: [{ type: 'question', prompt: '¿A qué dirección lo enviamos?', variable: 'direccion' }] },
          { type: 'message', text: 'Pedido anotado: {{pedido}} de {{restaurante}} ({{entrega}}). Te aviso cuando esté confirmado.' },
        ],
      });
    }

    // Conocimiento: esquema + conversaciones de ejemplo + ontologías
    const examples: string[] = [];
    const pickDialogues = (dls: SgdDialogue[], match: (s: string) => boolean, n: number, source: string) => {
      for (const dl of dls.filter((x) => x.services.some(match)).slice(0, n)) {
        examples.push(`### ${source} · ${dl.dialogue_id}\n\n${transcript(dl.turns.map((t) => ({ speaker: t.speaker, text: t.utterance })), 12)}`);
      }
    };
    pickDialogues(ctx.sgdDialogues, (s) => d.sgd.test(s), 8, 'SGD');
    pickDialogues(ctx.mwDialogues, (s) => d.mw.includes(s), 6, 'MultiWOZ 2.2');
    if (d.id === 'reservas-restaurantes') {
      for (const c of ctx.tmFood.slice(0, 5)) examples.push(`### Taskmaster-2 · pedido de comida\n\n${transcript(c.utterances, 12)}`);
    }
    const ontology = (d.tmOntologies ?? [])
      .map((o) => `### Taskmaster-2 · ${o}\n\n\`\`\`json\n${JSON.stringify(ctx.tmOnt[o], null, 1).slice(0, 2500)}\n\`\`\``)
      .join('\n\n');

    const knowledge = await writeKnowledge(d.id, {
      'esquema-de-datos.md': `# ${d.name}: qué datos pedir\n\nEstas son las intenciones y los datos que se manejan en este dominio.\n\n${schemaMarkdown([...sgdServices, ...mwServices], 'SGD / MultiWOZ 2.2')}${ontology ? `\n\n## Ontologías de Taskmaster-2\n\n${ontology}` : ''}`,
      'conversaciones-de-ejemplo.md': `# Conversaciones reales de ejemplo (en inglés)\n\nÚsalas como referencia de cómo guiar la conversación, no como datos reales de disponibilidad.\n\n${examples.join('\n\n')}`,
      'fuentes.md': `# Fuentes\n\n${SOURCES_MD}\n`,
    });

    agents.push({
      id: d.id,
      name: d.name,
      icon: d.icon,
      category: d.category,
      description: d.description,
      language: 'español',
      instructions: d.instructions,
      greeting: d.greeting,
      topics: [...topics.values()],
      knowledge,
      voice: { enabled: true },
      source: 'dataset',
    });
  }
  return agents;
}

// ---------- Bitext: atención al cliente ----------

async function buildBitext(): Promise<AgentDef> {
  const rows = parseCsv(await readText('bitext'));
  const [header, ...data] = rows;
  const col = (n: string) => header.indexOf(n);
  const iI = col('instruction'), iC = col('category'), iN = col('intent'), iR = col('response');
  const byIntent = new Map<string, { category: string; examples: string[]; responses: string[] }>();
  for (const r of data) {
    if (r.length < header.length) continue;
    const intent = r[iN];
    const e = byIntent.get(intent) ?? byIntent.set(intent, { category: r[iC], examples: [], responses: [] }).get(intent)!;
    e.examples.push(clean(r[iI]));
    e.responses.push(r[iR].trim());
  }
  // Respuesta modelo: la de longitud mediana (ni la más escueta ni la más larga)
  const median = (xs: string[]) => [...xs].sort((a, b) => a.length - b.length)[Math.floor(xs.length / 2)];
  const clearExamples = (xs: string[]) => uniq(xs.filter((x) => !/\{\{/.test(x) && x.length > 10 && x.length < 90)).slice(0, 8);

  const kb = [...byIntent.entries()]
    .sort((a, b) => a[1].category.localeCompare(b[1].category))
    .map(([intent, e]) => `## ${e.category} · ${intent}\n\nEl cliente dice cosas como: ${clearExamples(e.examples).slice(0, 5).map((x) => `"${x}"`).join(', ')}\n\nRespuesta modelo (adáptala al idioma del cliente y rellena los datos entre {{ }}):\n\n${median(e.responses)}`)
    .join('\n\n');

  const T = (intent: string) => clearExamples(byIntent.get(intent)?.examples ?? []);
  const topics: Topic[] = [
    { name: 'Seguir pedido', description: 'Saber dónde está un pedido', triggers: ['dónde está mi pedido', 'seguir mi pedido', 'estado del pedido', 'track my order', 'where is my order', ...T('track_order')],
      steps: [{ type: 'question', prompt: '¿Cuál es tu número de pedido?', variable: 'pedido' }, { type: 'generate', prompt: 'El cliente quiere saber el estado del pedido {{pedido}}. Explica cómo seguirlo según la base de conocimiento y ofrece ayuda.' }] },
    { name: 'Cancelar pedido', description: 'Cancelar una compra', triggers: ['cancelar mi pedido', 'quiero cancelar una compra', 'cancel my order', ...T('cancel_order')],
      steps: [
        { type: 'question', prompt: '¿Cuál es el número del pedido que quieres cancelar?', variable: 'pedido' },
        { type: 'question', prompt: '¿Confirmas la cancelación del pedido {{pedido}}?', variable: 'confirma', options: ['Sí', 'No'] },
        { type: 'condition', if: 'confirma == "Sí"', then: [{ type: 'message', text: 'Listo: he solicitado la cancelación del pedido {{pedido}}. Recibirás un correo de confirmación.' }], else: [{ type: 'message', text: 'De acuerdo, no cancelo nada. ¿Te ayudo con otra cosa?' }] },
      ] },
    { name: 'Cambiar dirección de envío', description: 'Modificar la dirección de un pedido', triggers: ['cambiar la dirección de envío', 'me equivoqué de dirección', 'change my shipping address', ...T('change_shipping_address')],
      steps: [{ type: 'question', prompt: '¿Número de pedido?', variable: 'pedido' }, { type: 'question', prompt: '¿Cuál es la nueva dirección completa?', variable: 'direccion' }, { type: 'message', text: 'He registrado la nueva dirección para el pedido {{pedido}}: {{direccion}}. Si el pedido ya salió, te avisaremos de las opciones.' }] },
    { name: 'Reembolso', description: 'Solicitar o consultar un reembolso', triggers: ['quiero un reembolso', 'devolución del dinero', 'dónde está mi reembolso', 'I want a refund', ...T('get_refund'), ...T('track_refund')],
      steps: [{ type: 'question', prompt: '¿Número de pedido?', variable: 'pedido' }, { type: 'question', prompt: '¿Cuál es el motivo?', variable: 'motivo', options: ['Producto defectuoso', 'No llegó', 'No es lo que pedí', 'Otro'] }, { type: 'generate', prompt: 'El cliente pide reembolso del pedido {{pedido}} por "{{motivo}}". Explica los pasos y plazos según la política de reembolsos de la base de conocimiento.' }] },
    { name: 'Hablar con una persona', description: 'Escalar a un agente humano', triggers: ['hablar con una persona', 'agente humano', 'quiero hablar con alguien', 'talk to a human', ...T('contact_human_agent')],
      steps: [{ type: 'question', prompt: 'Claro. Cuéntame en una frase el motivo para pasárselo al equipo.', variable: 'motivo' }, { type: 'message', text: 'Te paso con una persona del equipo con este resumen: "{{motivo}}". Te contactarán lo antes posible.' }] },
    { name: 'Queja', description: 'Registrar una queja o reclamación', triggers: ['quiero poner una queja', 'presentar una reclamación', 'file a complaint', ...T('complaint')],
      steps: [{ type: 'question', prompt: 'Siento lo ocurrido. ¿Qué ha pasado?', variable: 'queja' }, { type: 'question', prompt: '¿Un correo o teléfono para darte respuesta?', variable: 'contacto' }, { type: 'message', text: 'He registrado tu queja y te responderemos en {{contacto}}. Gracias por avisarnos.' }] },
  ];

  const knowledge = await writeKnowledge('soporte-al-cliente', {
    'respuestas-por-intencion.md': `# Atención al cliente: 27 intenciones (Bitext)\n\nCada sección tiene ejemplos de cómo lo pide el cliente y una respuesta modelo.\n\n${kb}`,
    'fuentes.md': `# Fuentes\n\n${SOURCES_MD}\n`,
  });
  return {
    id: 'soporte-al-cliente', name: 'Soporte al cliente', icon: '🎧',
    category: { function: 'Servicio al Cliente', useCase: 'Resolución de problemas' },
    description: `Pedidos, envíos, reembolsos, facturas, cuenta y pagos: ${byIntent.size} intenciones de Bitext con respuestas modelo.`,
    language: 'español',
    instructions: `Eres el agente de atención al cliente de una tienda online. Resuelves dudas sobre pedidos, envíos, cancelaciones, reembolsos, facturas, métodos de pago, cuenta y suscripciones. Usa las respuestas modelo de la base de conocimiento adaptándolas al cliente; si faltan datos (número de pedido, correo…), pídelos. Nunca pidas contraseñas ni datos completos de tarjeta.${BASE_RULES}`,
    greeting: '¡Hola! Soy el asistente de atención al cliente. ¿En qué te ayudo?',
    topics, knowledge, voice: { enabled: true }, source: 'dataset',
  };
}

// ---------- τ²-bench: aerolínea, tienda y telecom ----------

async function buildTau(): Promise<AgentDef[]> {
  const specs = [
    { key: 'tauAirline', id: 'aerolinea', name: 'Atención de aerolínea', icon: '🛫', category: { industry: 'Venta minorista', function: 'Servicio al Cliente', useCase: 'Reservas de vuelos' },
      description: 'Reservas, cambios, cancelaciones, equipaje y compensaciones según la política de aerolínea de τ²-bench.',
      topics: [
        { name: 'Cambiar vuelo', description: 'Modificar una reserva', triggers: ['cambiar mi vuelo', 'modificar mi reserva', 'change my flight'],
          steps: [{ type: 'question', prompt: '¿Cuál es tu ID de usuario?', variable: 'user_id' }, { type: 'question', prompt: '¿Y el código de la reserva?', variable: 'reserva' }, { type: 'generate', prompt: 'El usuario {{user_id}} quiere cambiar la reserva {{reserva}}. Aplica estrictamente la política (tipo de billete, cabina, plazos) y explica qué se puede hacer antes de actuar.' }] },
        { name: 'Cancelar reserva', description: 'Cancelar un vuelo', triggers: ['cancelar mi vuelo', 'cancelar la reserva', 'cancel my reservation'],
          steps: [{ type: 'question', prompt: '¿Cuál es tu ID de usuario?', variable: 'user_id' }, { type: 'question', prompt: '¿Código de la reserva?', variable: 'reserva' }, { type: 'question', prompt: '¿Motivo de la cancelación?', variable: 'motivo', options: ['Cambio de planes', 'La aerolínea canceló el vuelo', 'Salud o clima', 'Otro'] }, { type: 'generate', prompt: 'Reserva {{reserva}}, motivo "{{motivo}}". Según la política, indica si es cancelable y con qué reembolso. Pide confirmación explícita antes de cancelar.' }] },
        { name: 'Equipaje', description: 'Franquicia y equipaje extra', triggers: ['cuántas maletas puedo llevar', 'equipaje facturado', 'baggage allowance'],
          steps: [{ type: 'generate', prompt: 'Explica la franquicia de equipaje por cabina y nivel de socio según la política.' }] },
      ] as Topic[] },
    { key: 'tauRetail', id: 'tienda-online', name: 'Tienda online (devoluciones y cambios)', icon: '🛒', category: { industry: 'Venta minorista', function: 'Servicio al Cliente', useCase: 'Pedidos' },
      description: 'Estado de pedidos, cancelaciones, devoluciones, cambios y direcciones según la política de tienda de τ²-bench.',
      topics: [
        { name: 'Devolver pedido', description: 'Devolución de artículos entregados', triggers: ['devolver un pedido', 'quiero devolver', 'return my order'],
          steps: [{ type: 'question', prompt: 'Para verificar tu identidad, ¿me das tu correo o tu nombre y código postal?', variable: 'identidad' }, { type: 'question', prompt: '¿Número de pedido?', variable: 'pedido' }, { type: 'generate', prompt: 'El cliente ({{identidad}}) quiere devolver artículos del pedido {{pedido}}. Sigue la política: solo pedidos entregados, lista los artículos y el método de reembolso, y pide confirmación explícita.' }] },
        { name: 'Cambiar artículo', description: 'Cambiar un artículo por otro', triggers: ['cambiar un artículo', 'cambiar la talla', 'exchange an item'],
          steps: [{ type: 'question', prompt: 'Para verificar tu identidad, ¿me das tu correo o tu nombre y código postal?', variable: 'identidad' }, { type: 'question', prompt: '¿Número de pedido?', variable: 'pedido' }, { type: 'generate', prompt: 'Cambio de artículos del pedido {{pedido}}: según la política solo se cambia por otra variante del mismo producto. Reúne todos los artículos a cambiar y confirma antes de actuar.' }] },
      ] as Topic[] },
    { key: 'tauTelecom', id: 'soporte-telecom', name: 'Soporte técnico de telecom', icon: '📶', category: { function: 'Tecnologías de la información', useCase: 'Soporte técnico' },
      description: 'Facturación, planes, datos móviles e itinerancia según la política de telecom de τ²-bench.',
      topics: [
        { name: 'Sin datos móviles', description: 'El móvil no navega', triggers: ['no tengo datos', 'no me funciona internet en el móvil', 'mobile data not working'],
          steps: [{ type: 'question', prompt: '¿Cuál es tu número de teléfono?', variable: 'telefono' }, { type: 'generate', prompt: 'La línea {{telefono}} no tiene datos. Sigue los pasos de diagnóstico de la política uno a uno (modo avión, datos activados, itinerancia, APN, saldo de datos) y espera la respuesta del cliente en cada paso.' }] },
        { name: 'Factura', description: 'Dudas de facturación', triggers: ['mi factura', 'me han cobrado de más', 'pagar mi factura', 'billing'],
          steps: [{ type: 'question', prompt: '¿Cuál es tu número de cliente o teléfono?', variable: 'cliente' }, { type: 'generate', prompt: 'Duda de facturación del cliente {{cliente}}. Responde según la política de pagos y facturas.' }] },
      ] as Topic[] },
  ];
  const out: AgentDef[] = [];
  for (const s of specs) {
    const policy = await readText(s.key);
    const knowledge = await writeKnowledge(s.id, {
      'politica.md': `# Política (τ²-bench, licencia MIT)\n\n${policy}`,
      'fuentes.md': `# Fuentes\n\n${SOURCES_MD}\n`,
    });
    out.push({
      id: s.id, name: s.name, icon: s.icon, category: s.category, description: s.description, language: 'español',
      instructions: `Eres un agente de atención al cliente. Sigue ESTRICTAMENTE la política de la base de conocimiento: verifica la identidad antes de actuar, no prometas nada que la política no permita, explica las opciones y pide confirmación explícita ("sí") antes de cualquier acción que cambie una reserva, pedido o cuenta. Si el caso no está cubierto, transfiérelo a una persona.${BASE_RULES}`,
      greeting: '¡Hola! ¿En qué puedo ayudarte hoy?',
      topics: s.topics, knowledge, voice: { enabled: true }, source: 'dataset',
    });
  }
  return out;
}

// ---------- public-apis: catálogo y acciones reales ----------

interface PublicApi { category: string; name: string; url: string; description: string; auth: string; https: string; cors: string }

function parsePublicApis(md: string): PublicApi[] {
  const out: PublicApi[] = [];
  let category = '';
  for (const line of md.split('\n')) {
    const h = line.match(/^###\s+(.+)/);
    if (h) { category = h[1].trim(); continue; }
    const m = line.match(/^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/);
    if (m && category) out.push({ category, name: m[1].trim(), url: m[2].trim(), description: m[3].trim(), auth: m[4].replace(/`/g, '').trim(), https: m[5].trim(), cors: m[6].trim() });
  }
  return out;
}

async function buildApis(): Promise<AgentDef> {
  const apis = parsePublicApis(await readText('publicApis'));
  const free = apis.filter((a) => /^no$/i.test(a.auth) && /^yes$/i.test(a.https));
  const has = (name: string) => apis.some((a) => a.name.toLowerCase().includes(name.toLowerCase()));
  // Solo se usan como acciones las que están en el catálogo y se comprobaron sin clave
  const used = ['Open-Meteo', 'Frankfurter', 'Nager.Date'].filter(has);

  const byCat = new Map<string, PublicApi[]>();
  for (const a of free) (byCat.get(a.category) ?? byCat.set(a.category, []).get(a.category)!).push(a);
  const catalog = [...byCat.entries()].map(([c, xs]) => `## ${c}\n\n${xs.map((a) => `- [${a.name}](${a.url}): ${a.description}${/^yes$/i.test(a.cors) ? ' · CORS' : ''}`).join('\n')}`).join('\n\n');

  const actions: ActionDef[] = [
    { name: 'geocodificar', description: 'Busca una ciudad y devuelve su latitud, longitud y país (Open-Meteo Geocoding)', method: 'GET',
      url: 'https://geocoding-api.open-meteo.com/v1/search?name={{ciudad}}&count=1&language=es',
      parameters: { type: 'object', properties: { ciudad: { type: 'string', description: 'Nombre de la ciudad' } }, required: ['ciudad'] } },
    { name: 'clima', description: 'Tiempo actual y previsión de 3 días para unas coordenadas (Open-Meteo)', method: 'GET',
      url: 'https://api.open-meteo.com/v1/forecast?latitude={{lat}}&longitude={{lon}}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3',
      parameters: { type: 'object', properties: { lat: { type: 'number', description: 'Latitud' }, lon: { type: 'number', description: 'Longitud' } }, required: ['lat', 'lon'] } },
    { name: 'tipo_de_cambio', description: 'Tipo de cambio de referencia del BCE entre monedas (Frankfurter). Opcional: amount para convertir una cantidad.', method: 'GET',
      url: 'https://api.frankfurter.dev/v1/latest?base={{base}}&symbols={{destino}}',
      parameters: { type: 'object', properties: { base: { type: 'string', description: 'Moneda origen ISO 4217, p. ej. USD' }, destino: { type: 'string', description: 'Moneda(s) destino separadas por coma, p. ej. EUR,MXN' }, amount: { type: 'number', description: 'Cantidad a convertir (opcional)' } }, required: ['base', 'destino'] } },
    { name: 'proximos_festivos', description: 'Próximos días festivos de un país (Nager.Date)', method: 'GET',
      url: 'https://date.nager.at/api/v3/NextPublicHolidays/{{pais}}',
      parameters: { type: 'object', properties: { pais: { type: 'string', description: 'Código de país ISO 3166-1 alfa-2, p. ej. MX, ES, AR' } }, required: ['pais'] } },
    { name: 'festivos_del_anio', description: 'Todos los festivos de un país en un año (Nager.Date)', method: 'GET',
      url: 'https://date.nager.at/api/v3/PublicHolidays/{{anio}}/{{pais}}',
      parameters: { type: 'object', properties: { anio: { type: 'number', description: 'Año, p. ej. 2026' }, pais: { type: 'string', description: 'Código ISO alfa-2' } }, required: ['anio', 'pais'] } },
  ];

  const topics: Topic[] = [
    { name: 'Clima', description: 'Tiempo actual y previsión en una ciudad', triggers: ['qué tiempo hace', 'el clima en', 'va a llover', 'temperatura en', 'pronóstico del tiempo', 'weather in'],
      steps: [
        { type: 'question', prompt: '¿De qué ciudad?', variable: 'ciudad' },
        { type: 'action', action: 'geocodificar', inputs: { ciudad: '{{ciudad}}' }, saveAs: 'geo' },
        { type: 'condition', if: 'geo.body.results', then: [
          { type: 'action', action: 'clima', inputs: { lat: '{{geo.body.results.0.latitude}}', lon: '{{geo.body.results.0.longitude}}' }, saveAs: 'tiempo' },
          { type: 'message', text: 'En {{geo.body.results.0.name}} ({{geo.body.results.0.country}}) ahora hay {{tiempo.body.current.temperature_2m}} °C, humedad del {{tiempo.body.current.relative_humidity_2m}} % y viento de {{tiempo.body.current.wind_speed_10m}} km/h. Mañana: entre {{tiempo.body.daily.temperature_2m_min.1}} y {{tiempo.body.daily.temperature_2m_max.1}} °C, con {{tiempo.body.daily.precipitation_probability_max.1}} % de probabilidad de lluvia.' },
        ], else: [{ type: 'message', text: 'No encontré la ciudad "{{ciudad}}". ¿Puedes escribirla de otra forma?' }] },
      ] },
    { name: 'Tipo de cambio', description: 'Cotización entre dos monedas', triggers: ['tipo de cambio', 'cuánto está el dólar', 'convertir moneda', 'cotización del euro', 'exchange rate'],
      steps: [
        { type: 'question', prompt: '¿Moneda de origen?', variable: 'base', options: ['USD', 'EUR', 'MXN', 'GBP', 'BRL', 'JPY'] },
        { type: 'question', prompt: '¿A qué moneda?', variable: 'destino', options: ['USD', 'EUR', 'MXN', 'GBP', 'BRL', 'JPY'] },
        { type: 'action', action: 'tipo_de_cambio', inputs: { base: '{{base}}', destino: '{{destino}}' }, saveAs: 'fx' },
        { type: 'message', text: 'Tipo de cambio de referencia del BCE ({{fx.body.date}}): 1 {{base}} = {{fx.body.rates}}' },
      ] },
    { name: 'Próximos festivos', description: 'Días festivos de un país', triggers: ['próximo festivo', 'días festivos', 'cuándo es puente', 'feriados', 'public holidays'],
      steps: [
        { type: 'question', prompt: '¿De qué país? (código de 2 letras)', variable: 'pais', options: ['MX', 'ES', 'AR', 'CO', 'CL', 'PE', 'US'] },
        { type: 'action', action: 'proximos_festivos', inputs: { pais: '{{pais}}' }, saveAs: 'fest' },
        { type: 'message', text: 'Próximos festivos en {{pais}}: {{fest.body.0.localName}} ({{fest.body.0.date}}), {{fest.body.1.localName}} ({{fest.body.1.date}}) y {{fest.body.2.localName}} ({{fest.body.2.date}}).' },
      ] },
  ];

  const knowledge = await writeKnowledge('asistente-apis-publicas', {
    'catalogo-apis-sin-clave.md': `# APIs públicas sin clave y con HTTPS (${free.length} de ${apis.length})\n\nExtraído de public-apis (MIT). Úsalo para recomendar integraciones; las acciones disponibles ahora mismo son: ${used.join(', ')}.\n\n${catalog}`,
    'fuentes.md': `# Fuentes\n\n${SOURCES_MD}\n`,
  });
  return {
    id: 'asistente-apis-publicas', name: 'Asistente con APIs públicas', icon: '🌐',
    category: { function: 'Tecnologías de la información', useCase: 'Integraciones' },
    description: `Clima, tipo de cambio y festivos con APIs reales (${used.join(', ')}), y un catálogo de ${free.length} APIs públicas sin clave para recomendar integraciones.`,
    language: 'español',
    instructions: `Eres un asistente práctico conectado a APIs públicas reales. Usa las acciones para el tiempo (primero geocodificar la ciudad y luego clima), el tipo de cambio y los días festivos. Da siempre la fuente del dato. Si te piden otra integración, recomienda APIs del catálogo de la base de conocimiento (todas sin clave y con HTTPS) y explica cómo llamarlas.${BASE_RULES}`,
    greeting: '¡Hola! Puedo decirte el tiempo de una ciudad, el tipo de cambio entre monedas o los próximos festivos. ¿Qué necesitas?',
    topics, actions, knowledge, voice: { enabled: true }, source: 'dataset',
  };
}

// ---------- principal ----------

async function main() {
  await mkdir(CACHE, { recursive: true });
  console.log('Descargando fuentes (solo los archivos necesarios)…');
  const sgd = await readJson<SgdService[]>('sgdSchema');
  const mw = await readJson<SgdService[]>('mwSchema');
  const sgdDialogues = [...(await readJson<SgdDialogue[]>('sgdDlg1')), ...(await readJson<SgdDialogue[]>('sgdDlg2'))];
  const mwDialogues = await readJson<SgdDialogue[]>('mwDlg1');
  const tmFood = await readJson<{ utterances: { speaker: string; text: string }[] }[]>('tmFood');
  const tmOnt: Record<string, unknown> = {};
  for (const k of Object.keys(FILES).filter((k) => k.startsWith('tmOnt_'))) {
    const v = await readJson<Record<string, unknown>>(k);
    tmOnt[k.slice(6)] = Object.values(v)[0] ?? v;
  }

  console.log('Generando agentes…');
  const agents = [
    ...(await buildDomainAgents({ sgd, mw, sgdTriggers: triggersByIntent(sgdDialogues), mwTriggers: triggersByIntent(mwDialogues), sgdDialogues, mwDialogues, tmOnt, tmFood })),
    await buildBitext(),
    ...(await buildTau()),
    await buildApis(),
  ];
  for (const a of agents) {
    await saveAgent(a);
    console.log(`✔ ${a.icon} ${a.name} (${a.id}): ${a.topics?.length ?? 0} temas, ${a.knowledge?.length ?? 0} fuentes, ${a.actions?.length ?? 0} acciones`);
  }

  if (!KEEP) {
    for (const [k, f] of Object.entries(FILES)) if (f.big) await rm(join(CACHE, `${k}${f.url.endsWith('.csv') ? '.csv' : '.json'}`), { force: true });
    console.log('Caché grande borrada (usa --keep para conservarla).');
  }
}

await main();
