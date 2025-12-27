const { SlashCommandBuilder, AttachmentBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("paletteswap")
    .setDescription("Palette swap a sprite")
    .addAttachmentOption((option) =>
      option.setName("sprite").setDescription("The sprite to swap the palette of").setRequired(true)
    )
    .addStringOption((option) => option.setName("palette").setDescription("The Lospec palette name").setRequired(false))
    .addBooleanOption((option) =>
      option
        .setName("unique")
        .setDescription("Use unique palette colors per original (no reuse until palette exhausted)")
        .setRequired(false)
    ),
  async execute(interaction) {
    const sprite = interaction.options.getAttachment("sprite");
    let paletteName = interaction.options.getString("palette") ?? "resurrect-64";
    paletteName = paletteName.toLowerCase().replace(/ /g, "-");
    const unique = interaction.options.getBoolean("unique") ?? false;

    let spriteText;
    try {
      const spriteData = await fetchWithTimeout(sprite.url, 2000);
      spriteText = await spriteData.text();
    } catch (err) {
      await interaction.reply({ content: `Failed to fetch sprite: ${err.message}`, ephemeral: true });
      return;
    }

    let paletteText;
    let paletteData;
    try {
      paletteData = await fetchWithTimeout(`https://lospec.com/palette-list/${paletteName}.hex`, 2000);
      paletteText = await paletteData.text();
    } catch (err) {
      await interaction.reply({ content: `Failed to fetch palette: ${err.message}`, ephemeral: true });
      return;
    }

    if (!paletteData.ok) {
      await interaction.reply({ content: `Palette "${paletteName}" not found on Lospec.`, ephemeral: true });
      return;
    }

    if (!/[0-9a-fA-F]{6}/.test(paletteText)) {
      await interaction.reply({ content: `Palette "${paletteName}" appears invalid or is unavailable.`, ephemeral: true });
      return;
    }

    console.log(spriteText);
    console.log(paletteText);

    const mappings = extractHexCodes(spriteText, paletteText, unique);
    console.log(mappings);

    function escapeRegExp(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    for (const m of mappings) {
      const re = new RegExp(escapeRegExp(m.original), "gi");
      spriteText = spriteText.replace(re, m.new);
    }

    const spriteTextBuffer = Buffer.from(spriteText);

    const name =
      sprite.name.slice(0, sprite.name.lastIndexOf(".")) +
      "-" +
      paletteName +
      sprite.name.slice(sprite.name.lastIndexOf("."));

    const attachment = new AttachmentBuilder(spriteTextBuffer, {
      name: name
    });

    console.log(attachment);

    interaction.reply({ files: [attachment] });
  }
};

function extractHexCodes(str, paletteText, unique = false) {
  const regex = /(["'])(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\1/g;
  const seen = new Set();
  const results = [];
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
      value = value.split("").map((c) => c + c).join("");
    }

    const normalized = "#" + value.toUpperCase();

    if (!seen.has(normalized)) {
      seen.add(normalized);
      found.push({ original, normalized });
    }
  }

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
    if (err.name === 'AbortError') throw new Error('request timed out');
    throw err;
  }
}
