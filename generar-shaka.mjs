import fs from "fs";

const ORIGEN = "https://raw.githubusercontent.com/matiasugarte-oss/Shaka-Feed/main/feed.xml";
const DOMINIO = "sh-aka.com.ar";
const ARCHIVO = "publicar/shaka.xml";

const esc = (t) => String(t ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const decodificarUnaVez = (t) => String(t || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;|&#039;|&#39;/g, "'").replace(/&amp;/g, "&");
const decodificar = (t) => decodificarUnaVez(decodificarUnaVez(t)).trim();

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const campo = (bloque, nombre) => {
  const m = bloque.match(new RegExp(`<g:${nombre}>([\\s\\S]*?)</g:${nombre}>`));
  return m ? decodificar(m[1]) : "";
};
const numero = (t) => {
  const m = String(t || "").replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
};
const moneda = (t) => (String(t || "").match(/[A-Z]{3}/) || ["ARS"])[0];

async function traerFeed(url) {
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      console.log(`  Intento ${intento} fallo (codigo ${res.status})`);
    } catch (e) {
      console.log(`  Intento ${intento} fallo (${e.message})`);
    }
    await pausa(5000 * intento);
  }
  throw new Error(`No se pudo leer ${url}`);
}

try {
  console.log("Leyendo feed de origen...");
  const original = await traerFeed(ORIGEN);
  const bloques = original.match(/<item>[\s\S]*?<\/item>/g) || [];
  console.log(`  ${bloques.length} items en el feed original`);

  const grupos = {};
  for (const b of bloques) {
    const v = {
      id: campo(b, "id"),
      titulo: campo(b, "title"),
      descripcion: campo(b, "description"),
      link: campo(b, "link").split("?")[0],
      imagen: campo(b, "image_link"),
      estado: campo(b, "availability"),
      fecha: campo(b, "availability_date"),
      precio: numero(campo(b, "price")),
      oferta: numero(campo(b, "sale_price")),
      moneda: moneda(campo(b, "price")),
      marca: campo(b, "brand"),
      tipo: campo(b, "product_type"),
      talle: campo(b, "size"),
      color: campo(b, "color"),
    };
    if (!v.link || /puntos/i.test(v.talle)) continue;
    (grupos[v.link] ||= []).push(v);
  }

  const lista = Object.entries(grupos);
  if (lista.length === 0) throw new Error("El feed no tiene productos");

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
  <channel>
    <title>Feed de productos ${esc(DOMINIO)}</title>
    <link>https://${esc(DOMINIO)}</link>
    <description>Catalogo completo de productos</description>\n`;

  for (const [link, variantes] of lista) {
    const enStock = variantes.filter((v) => v.estado === "in_stock");
    const preventa = variantes.filter((v) => v.estado === "preorder");
    const disponibles = enStock.length ? enStock : preventa;
    const base = disponibles[0] || variantes[0];
    const estado = enStock.length ? "in_stock" : preventa.length ? "preorder" : "out_of_stock";

    const titulo = base.titulo.replace(/\s*-\s*Talle\s+.*$/i, "").trim();
    const talles = [...new Set(disponibles.map((v) => v.talle).filter((t) => t && t !== "Único"))];
    const colores = [...new Set(disponibles.map((v) => v.color).filter(Boolean))];

    let descripcion = (variantes.find((v) => v.descripcion) || {}).descripcion || "";
    descripcion = descripcion
      .replace(/Compr[aá] online[^.]*\./gi, "")
      .replace(/Hac[eé] tu pedido y pagalo online\.?/gi, "")
      .trim();
    if (!descripcion || descripcion.length < 10) descripcion = titulo;
    if (talles.length) descripcion += ` Talles disponibles: ${talles.join(", ")}.`;
    if (colores.length) descripcion += ` Color: ${colores.join(", ")}.`;
    if (estado === "preorder" && base.fecha) {
      const [anio, mes, dia] = base.fecha.slice(0, 10).split("-");
      descripcion += ` Preventa: entrega a partir del ${dia}/${mes}/${anio}.`;
    }

    const oferta = base.oferta && base.oferta < base.precio ? base.oferta : 0;
    const categoria = base.tipo.split(">")[0].trim();

    xml += `    <item>
      <g:id>${esc(base.id)}</g:id>
      <g:title>${esc(titulo)}</g:title>
      <g:description>${esc(descripcion)}</g:description>
      <g:link>${esc(link)}</g:link>
      <g:image_link>${esc(base.imagen)}</g:image_link>
      <g:availability>${estado}</g:availability>
      <g:price>${base.precio.toFixed(2)} ${base.moneda}</g:price>\n`;
    if (oferta) xml += `      <g:sale_price>${oferta.toFixed(2)} ${base.moneda}</g:sale_price>\n`;
    xml += `      <g:brand>${esc(base.marca)}</g:brand>
      <g:product_type>${esc(categoria)}</g:product_type>
      <g:condition>new</g:condition>
      <g:identifier_exists>no</g:identifier_exists>
    </item>\n`;
  }
  xml += `  </channel>\n</rss>\n`;

  fs.mkdirSync("publicar", { recursive: true });
  fs.writeFileSync(ARCHIVO, xml);
  const kb = (Buffer.byteLength(xml) / 1024).toFixed(0);
  console.log(`shaka.xml: ${lista.length} productos guardados (${kb} KB)`);
} catch (e) {
  console.log(`shaka.xml: NO se genero (${e.message}). El link mantiene la version anterior.`);
  process.exitCode = 1;
}
