const { SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require("discord.js");
const render = require("svg-render");
const sharp = require("sharp");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("paletteswap")
    .setDescription("Palette swap a sprite")
    .addAttachmentOption((option) =>
      option.setName("sprite").setDescription("The sprite to swap the palette of").setRequired(true)
    )
    .addStringOption((option) => option.setName("palette").setDescription("The Lospec palette name (https://lospec.com/palette-list)").setRequired(false))
    .addBooleanOption((option) =>
      option
        .setName("unique")
        .setDescription("Preserve unique colors when mapping to the new palette (will fry noisy images)")
        .setRequired(false)
    ),
  async execute(interaction) {
    const sprite = interaction.options.getAttachment("sprite");
    let paletteName = interaction.options.getString("palette") ?? "resurrect-64";
    paletteName = paletteName.toLowerCase().replace(/ /g, "-");
    const unique = interaction.options.getBoolean("unique") ?? false;

    if (sprite.name.endsWith(".svg")) {
      spriteType = "vector";
    } else if (sprite.name.endsWith(".png")) {
      spriteType = "bitmap";
    } else {
      await interaction.reply({
        content: `Unsupported image type! Try \`.png\` or \`.svg\`.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    let spriteData;
    try {
      spriteData = await fetchWithTimeout(sprite.url, 2000);
    } catch (err) {
      await interaction.reply({ content: `Failed to fetch sprite: ${err.message}`, flags: MessageFlags.Ephemeral });
      return;
    }

    let paletteText;
    let paletteData;
    try {
      paletteData = await fetchWithTimeout(`https://lospec.com/palette-list/${paletteName}.hex`, 2000);
      paletteText = await paletteData.text();
    } catch (err) {
      await interaction.reply({
        content: `Palette "${paletteName}" not found on Lospec.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (!/[0-9a-fA-F]{6}/.test(paletteText)) {
      await interaction.reply({
        content: `Palette "${paletteName}" appears invalid or is unavailable.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    try {
      await interaction.deferReply();
    } catch (err) {
      return;
    }

    let attachments;
    if (spriteType == "vector") {
      attachments = await recolorSvg(sprite, spriteData, paletteText, unique, paletteName);
    } else if (spriteType == "bitmap") {
      attachments = await recolorPng(sprite, spriteData, paletteText, unique, paletteName);
      if (attachments.length === 0) {
        await interaction.editReply({
          content: `Unsupported image type! Try \`.png\` or \`.svg\``,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    try {
      interaction.editReply({ files: attachments });
    } catch (err) {}
  }
};

async function recolorSvg(sprite, spriteData, paletteText, unique, paletteName) {
  let spriteText = await spriteData.text();
  const mappings = extractHexCodes(spriteText, paletteText, unique);

  for (const m of mappings) {
    const re = new RegExp(m.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    spriteText = spriteText.replace(re, m.new);
  }

  const spriteTextBuffer = Buffer.from(spriteText);

  const name =
    sprite.name.slice(0, sprite.name.lastIndexOf(".")) +
    "-" +
    paletteName +
    sprite.name.slice(sprite.name.lastIndexOf("."));

  const spritePngBuffer = await render({
    buffer: spriteTextBuffer,
    width: 256
  });

  const svgattachment = new AttachmentBuilder(spriteTextBuffer, {
    name: name
  });
  const pngattachment = new AttachmentBuilder(spritePngBuffer, {
    name: name.replace(/svg(?!.*svg)/, "png")
  });

  return [svgattachment, pngattachment];
}

async function recolorPng(sprite, spriteData, paletteText, unique, paletteName) {
  const paletteColors = paletteText
    .trim()
    .split(/\s+/)
    .filter((hex) => /^[0-9a-fA-F]{6}$/.test(hex))
    .map((hex) => "#" + hex.toUpperCase());

  const arrayBuffer = await spriteData.arrayBuffer();
  const imgBuffer = Buffer.from(arrayBuffer);
  
  let metadata;
  let pixelData;
  try {
    metadata = await sharp(imgBuffer).metadata();
    const rawData = await sharp(imgBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    pixelData = rawData.data;
  } catch (err) {
    return [];
  }

  const uniqueColors = new Map();
  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    const a = pixelData[i + 3];
    const hex = `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0").toUpperCase()}`;
    if (!uniqueColors.has(hex)) {
      uniqueColors.set(hex, { r, g, b, a, hex });
    }
  }

  const found = Array.from(uniqueColors.values()).map((c) => ({
    original: c.hex,
    normalized: c.hex
  }));
  const mappings = paletteMatch([], found, paletteColors, unique);

  const colorMap = new Map();
  for (const m of mappings) {
    const rgb = hexToRgb(m.original);
    const newRgb = hexToRgb(m.new);
    const key = `${rgb.r},${rgb.g},${rgb.b}`;
    colorMap.set(key, newRgb);
  }

  for (let i = 0; i < pixelData.length; i += 4) {
    const r = pixelData[i];
    const g = pixelData[i + 1];
    const b = pixelData[i + 2];
    const key = `${r},${g},${b}`;
    if (colorMap.has(key)) {
      const newRgb = colorMap.get(key);
      pixelData[i] = newRgb.r;
      pixelData[i + 1] = newRgb.g;
      pixelData[i + 2] = newRgb.b;
    }
  }

  const pngBuffer = await sharp(pixelData, {
    raw: {
      width: metadata.width,
      height: metadata.height,
      channels: 4
    }
  })
    .png()
    .toBuffer();

  const name =
    sprite.name.slice(0, sprite.name.lastIndexOf(".")) +
    "-" +
    paletteName +
    sprite.name.slice(sprite.name.lastIndexOf("."));

  const pngattachment = new AttachmentBuilder(pngBuffer, {
    name: name
  });

  return [pngattachment];
}

function extractHexCodes(str, paletteText, unique = false) {
  const regex = /(["'])(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\1/g;
  const seen = new Set();
  let results = [];
  let match;

  const paletteColors = paletteText
    .trim()
    .split(/\s+/)
    .filter((hex) => /^[0-9a-fA-F]{6}$/.test(hex))
    .map((hex) => "#" + hex.toUpperCase());

  if (paletteColors.length === 0) {
    while ((match = regex.exec(str)) !== null) {
      const original = match[2];
      let value = original.slice(1);

      if (value.length === 3) {
        value = value
          .split("")
          .map((c) => c + c)
          .join("");
      }

      const normalized = "#" + value.toUpperCase();

      if (!seen.has(normalized)) {
        seen.add(normalized);
        results.push({ original: original, normalized: normalized, new: normalized });
      }
    }

    return results;
  }

  const found = [];
  while ((match = regex.exec(str)) !== null) {
    const original = match[2];
    let value = original.slice(1);

    if (value.length === 3) {
      value = value
        .split("")
        .map((c) => c + c)
        .join("");
    }

    const normalized = "#" + value.toUpperCase();

    if (!seen.has(normalized)) {
      seen.add(normalized);
      found.push({ original, normalized });
    }
  }

  results = paletteMatch(results, found, paletteColors, unique);

  return results;
}

function findClosestColor(hexColor, paletteColors) {
  const rgb1 = hexToRgb(hexColor);
  let closest = paletteColors[0];
  let minDistance = Infinity;

  for (const paletteColor of paletteColors) {
    const rgb2 = hexToRgb(paletteColor);
    const distance = Math.sqrt(
      Math.pow(rgb1.r - rgb2.r, 2) + Math.pow(rgb1.g - rgb2.g, 2) + Math.pow(rgb1.b - rgb2.b, 2)
    );

    if (distance < minDistance) {
      minDistance = distance;
      closest = paletteColor;
    }
  }

  return closest;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
      }
    : { r: 0, g: 0, b: 0 };
}

async function fetchWithTimeout(resource, ms = 2000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(resource, { signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    if (err.name === "AbortError") throw new Error("request timed out");
    throw err;
  }
}

function paletteMatch(results, found, paletteColors, unique) {
  if (unique) {
    const minDistance = (hex) => {
      const rgb1 = hexToRgb(hex);
      let min = Infinity;
      for (const p of paletteColors) {
        const rgb2 = hexToRgb(p);
        const d = Math.pow(rgb1.r - rgb2.r, 2) + Math.pow(rgb1.g - rgb2.g, 2) + Math.pow(rgb1.b - rgb2.b, 2);
        if (d < min) min = d;
      }
      return Math.sqrt(min);
    };

    found.sort((a, b) => minDistance(a.normalized) - minDistance(b.normalized));

    let available = paletteColors.slice();
    for (const item of found) {
      if (available.length === 0) available = paletteColors.slice();
      const chosen = findClosestColor(item.normalized, available);
      const idx = available.indexOf(chosen);
      if (idx !== -1) available.splice(idx, 1);
      results.push({ original: item.original, normalized: item.normalized, new: chosen });
    }
  } else {
    for (const item of found) {
      const closest = findClosestColor(item.normalized, paletteColors);
      results.push({ original: item.original, normalized: item.normalized, new: closest });
    }
  }
  return results;
}
