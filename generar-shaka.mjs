import fs from "fs";

const ORIGEN = "https://raw.githubusercontent.com/matiasugarte-oss/Shaka-Feed/main/feed.xml";
const DOMINIO = "sh-aka.com.ar";
const ARCHIVO = "publicar/shaka.xml";

const NAVEGADOR = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "es-AR,es;q=0.9",
};

const esc = (t) => String(t ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const entidades = (t) => String(t || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, "&").trim();

const limpiar = (html) => entidades(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const sinFrasesViejas = (t) => String(t || "")
  .replace(/Compr[aá] online[^.]*\./gi, "")
  .replace(/Hac[eé] tu pedido y pagalo online\.?/gi, "")
  .replace(/\s+/g, " ").trim();
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

const campo = (bloque, nombre) => {
  const m = bloque.match(new RegExp(`<g:${nombre}>([\\s\\S]*?)</g:${nombre}>`));
  return m ? entidades(m[1]) : "";
};
const numero = (t) => {
  const m = String(t || "").replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};
const moneda = (t) => (String(t || "").match(/[A-Z]{3}/) || ["ARS"])[0];

async function traer(url, intentos = 3) {
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const res = await fetch(url, { headers: NAVEGADOR });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
      console.log(`  ${url} -> intento ${intento} fallo (codigo ${res.status})`);
    } catch (e) {
      console.log(`  ${url} -> intento ${intento} fallo (${e.message})`);
    }
    await pausa(3000 * intento);
  }
  return null;
}

function meta(html, nombre) {
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${nombre}["'][^>]*content=["']([^"']*)["']`, "i"));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${nombre}["']`, "i"));
  return entidades((a || b || [])[1] || "");
}

function descripcionJsonLd(html) {
  for (const [, contenido] of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const datos = JSON.parse(contenido);
      const todos = [datos, ...(Array.isArray(datos) ? datos : []), ...(datos["@graph"] || [])];
      const producto = todos.find((o) => o && o["@type"] === "Product");
      if (producto?.description) return limpiar(producto.description);
    } catch {}
  }
  return "";
}

try {
  console.log("Leyendo feed de origen...");
  const original = await traer(ORIGEN);
  if (!original) throw new Error("No se pudo leer el feed de origen");

  const bloques = original.match(/<item>[\s\S]*?<\/item>/g) || [];
  console.log(`  ${bloques.length} items en el feed original`);

  const grupos = {};
  for (const b of bloques) {
    const v = {
      id: campo(b, "id"),
      link: campo(b, "link").split("?")[0],
      imagen: campo(b, "image_link"),
      estado: campo(b, "availability"),
      fecha: campo(b, "availability_date"),
      precio: numero(campo(b, "price")),
      oferta: numero(campo(b, "sale_price")),
      moneda: moneda(campo(b, "price")),
      marca: campo(b, "brand"),
      talle: campo(b, "size"),
      color: campo(b, "color"),
    };
    if (!v.link || /puntos/i.test(v.talle)) continue;
    (grupos[v.link] ||= []).push(v);
  }
  const lista = Object.entries(grupos);
  console.log(`  ${lista.length} productos distintos (por link)`);
  if (lista.length === 0) throw new Error("El feed no tiene productos");

  let sinPagina = 0;
  const ejemplos = [];
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>Feed de productos ${esc(DOMINIO)}</title>
    <link>https://${esc(DOMINIO)}</link>
    <description>Catalogo completo de productos</description>\n`;
  let guardados = 0;

  for (const [link, variantes] of lista) {
    const html = await traer(link);
    await pausa(700);
    if (!html) { sinPagina++; console.log(`  Sin pagina: ${link}`); continue; }

    let titulo = meta(html, "og:title") || limpiar((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    titulo = titulo.replace(/\s[-|–]\s*Shaka Cmmnty\s*$/i, "").trim();
    if (!titulo) { sinPagina++; console.log(`  Sin titulo en la pagina: ${link}`); continue; }

    let descripcion = sinFrasesViejas(descripcionJsonLd(html) || meta(html, "og:description") || meta(html, "description"));
    if (descripcion.length < 10) descripcion = titulo;
    descripcion = descripcion.slice(0, 600);

    const enStock = variantes.filter((v) => v.estado === "in_stock");
    const preventa = variantes.filter((v) => v.estado === "preorder");
    const disponibles = enStock.length ? enStock : preventa;
    const base = disponibles[0] || variantes[0];
    const estado = enStock.length ? "in_stock" : preventa.length ? "preorder" : "out_of_stock";

    const talles = [...new Set(disponibles.map((v) => v.talle).filter((t) => t && !/^[uú]nico$/i.test(t)))];
    if (talles.length) descripcion += ` Talles disponibles: ${talles.join(", ")}.`;
    if (estado === "preorder" && base.fecha) {
      const [anio, mes, dia] = base.fecha.slice(0, 10).split("-");
      descripcion += ` Preventa: entrega a partir del ${dia}/${mes}/${anio}.`;
    }

    const oferta = base.oferta && base.oferta < base.precio ? base.oferta : 0;

    xml += `    <item>
      <g:id>${esc(base.id)}</g:id>
      <g:title>${esc(titulo)}</g:title>
      <g:description>${esc(descripcion)}</g:description>
      <g:link>${esc(link)}</g:link>
      <g:image_link>${esc(base.imagen)}</g:image_link>
      <g:availability>${estado}</g:availability>
      <g:price>${base.precio.toFixed(2)} ${base.moneda}</g:price>\n`;
    if (oferta) xml += `      <g:sale_price>${oferta.toFixed(2)} ${base.moneda}</g:sale_price>\n`;
    xml += `      <g:brand>${esc(base.marca || "Shaka Cmmnty")}</g:brand>
      <g:condition>new</g:condition>
      <g:identifier_exists>no</g:identifier_exists>
    </item>\n`;
    guardados++;
    if (ejemplos.length < 3) ejemplos.push(`${titulo} | ${link}`);
  }
  xml += `  </channel>\n</rss>\n`;

  console.log(`  Paginas que no se pudieron leer: ${sinPagina}`);
  console.log("  Ejemplos para revisar:");
  ejemplos.forEach((e) => console.log(`    ${e}`));

  if (guardados === 0) throw new Error("No se pudo leer ninguna pagina de producto");

  fs.mkdirSync("publicar", { recursive: true });
  fs.writeFileSync(ARCHIVO, xml);
  console.log(`shaka.xml: ${guardados} de ${lista.length} productos guardados (${(Buffer.byteLength(xml) / 1024).toFixed(0)} KB)`);

  if (guardados < lista.length * 0.5) {
    console.log("AVISO: se pudieron leer menos de la mitad de las paginas.");
    process.exitCode = 1;
  }
} catch (e) {
  console.log(`shaka.xml: NO se genero (${e.message}). El link mantiene la version anterior.`);
  process.exitCode = 1;
}
