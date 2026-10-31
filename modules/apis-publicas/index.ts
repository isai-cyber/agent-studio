// APIs públicas sin clave (del catálogo public-apis): clima, divisas y festivos.
import type { ModuleDef } from '../../src/modules/sdk.ts';

export default {
  key: 'apis-publicas',
  name: 'APIs públicas',
  description: 'Clima (Open-Meteo), tipo de cambio (Frankfurter) y festivos (Nager.Date). Sin claves.',
  icon: '🌦️',
  color: '#3fd6d0',
  category: 'Datos',
  author: 'CrawStudio A.I',
  version: '1.0.0',
  homepage: 'https://github.com/public-apis/public-apis',
  actions: [
    {
      key: 'weather', name: 'Clima de una ciudad', description: 'Temperatura, humedad, viento y previsión de mañana.',
      arguments: [{ key: 'city', label: 'Ciudad', type: 'string', required: true, variables: true, placeholder: 'Guadalajara' }],
      async run(ctx) {
        const geo = await ctx.fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(ctx.args.city))}&count=1&language=es`);
        const place = geo.results?.[0];
        if (!place) throw new Error(`No encontré la ciudad "${ctx.args.city}"`);
        const w = await ctx.fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2`);
        return {
          ciudad: place.name, pais: place.country,
          temperatura: w.current.temperature_2m, humedad: w.current.relative_humidity_2m, viento: w.current.wind_speed_10m,
          manana: { min: w.daily.temperature_2m_min[1], max: w.daily.temperature_2m_max[1], lluvia: w.daily.precipitation_probability_max[1] },
          resumen: `${place.name}: ${w.current.temperature_2m} °C ahora; mañana entre ${w.daily.temperature_2m_min[1]} y ${w.daily.temperature_2m_max[1]} °C (${w.daily.precipitation_probability_max[1]} % de lluvia).`,
        };
      },
    },
    {
      key: 'exchange', name: 'Tipo de cambio', description: 'Cotización de referencia del Banco Central Europeo.',
      arguments: [
        { key: 'from', label: 'De', type: 'string', required: true, default: 'USD' },
        { key: 'to', label: 'A', type: 'string', required: true, default: 'MXN' },
        { key: 'amount', label: 'Cantidad', type: 'number', default: 1, variables: true },
      ],
      async run(ctx) {
        const amount = Number(ctx.args.amount) || 1;
        const d = await ctx.fetchJson(`https://api.frankfurter.dev/v1/latest?base=${ctx.args.from}&symbols=${ctx.args.to}&amount=${amount}`);
        const value = d.rates?.[String(ctx.args.to).toUpperCase()];
        return { fecha: d.date, de: d.base, a: ctx.args.to, cantidad: amount, resultado: value, resumen: `${amount} ${d.base} = ${value} ${ctx.args.to} (${d.date})` };
      },
    },
    {
      key: 'holidays', name: 'Próximos festivos', description: 'Lista de próximos días festivos de un país.',
      arguments: [{ key: 'country', label: 'País (código de 2 letras)', type: 'string', required: true, default: 'MX' }],
      async run(ctx) {
        const list = await ctx.fetchJson(`https://date.nager.at/api/v3/NextPublicHolidays/${String(ctx.args.country).toUpperCase()}`);
        const next = (list as { date: string; localName: string }[]).slice(0, 5);
        return { pais: ctx.args.country, proximo: next[0], festivos: next, resumen: next.map((h) => `${h.localName} (${h.date})`).join(', ') };
      },
    },
  ],
} satisfies ModuleDef;
