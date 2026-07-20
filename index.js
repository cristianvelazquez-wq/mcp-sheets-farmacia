import express from "express";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuración de Google Sheets
let doc;
try {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
} catch (e) {
  console.error("Error cargando credenciales:", e);
}

// Estructura de la herramienta que busca Botmaker
const TOOL_MANIFEST = {
  tools: [
    {
      name: "consultar_producto",
      description: "Busca productos en la farmacia por nombre, descripción, SKU o código de barras en tiempo real.",
      inputSchema: {
        type: "object",
        properties: {
          busqueda: { type: "string", description: "Nombre, SKU o código de barras del producto" }
        },
        required: ["busqueda"]
      }
    }
  ]
};

// Función de búsqueda en Google Sheets
async function ejecutarBusqueda(query) {
  if (!doc) return [];
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();
  const q = (query || '').toLowerCase();

  return rows.filter(row => {
    const descrip = (row.get('descrip') || '').toLowerCase();
    const sku = (row.get('sku') || '').toString().toLowerCase();
    const barras = (row.get('barras') || '').toString().toLowerCase();
    return descrip.includes(q) || sku.includes(q) || barras.includes(q);
  }).map(row => ({
    sku: row.get('sku'),
    barras: row.get('barras'),
    descripcion: row.get('descrip'),
    precio: row.get('precio'),
    stock: row.get('stock')
  })).slice(0, 5);
}

// 1. Respuesta inmediata para cuando Botmaker descubre las herramientas
app.get("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    jsonrpc: "2.0",
    result: TOOL_MANIFEST
  });
});

// 2. Respuesta para cuando el Agente ejecuta la búsqueda
app.post("*", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const body = req.body || {};
  const id = body.id || 1;

  // Si Botmaker pide lista de herramientas vía POST
  if (body.method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: TOOL_MANIFEST
    });
  }

  // Si Botmaker llama a la herramienta
  if (body.method === "tools/call" || body.params?.name === "consultar_producto") {
    try {
      const busqueda = body.params?.arguments?.busqueda || body.busqueda || "";
      const resultados = await ejecutarBusqueda(busqueda);
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(resultados) }]
        }
      });
    } catch (err) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: err.message }
      });
    }
  }

  // Respuesta por defecto
  res.json({
    jsonrpc: "2.0",
    id,
    result: TOOL_MANIFEST
  });
});

app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
