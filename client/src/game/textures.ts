import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

/**
 * 程序產生的材質貼圖（Canvas 2D）。不使用任何外部圖檔。
 * 色票：骨白 #E8E5DC、霧灰 #A8AAA5、炭黑 #242729、朱紅 #C64B3C、舊黃銅 #C5A568
 */
export const C = {
  bone: '#E8E5DC',
  bone2: '#DCD8CD',
  fog: '#A8AAA5',
  ink: '#242729',
  red: '#C64B3C',
  brass: '#C5A568',
} as const;

const SANS = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';

const cache = new Map<string, CanvasTexture>();

function make(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false): CanvasTexture {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  cache.set(key, t);
  return t;
}

/** 固定亂數（同一張貼圖每次產生都一樣） */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function grain(g: CanvasRenderingContext2D, w: number, h: number, n: number, alpha: number, seed: number): void {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = r() > 0.5 ? `rgba(36,39,41,${alpha})` : `rgba(255,255,255,${alpha})`;
    g.fillRect(r() * w, r() * h, 1 + r() * 1.5, 1 + r() * 1.5);
  }
}

/**
 * 牆板模組：寬 1.2m、高 3.2m（整面牆高）。
 * 下段 0.9m 是霧灰粉體烤漆護牆，中間一道炭黑分隔條；上段是象牙白琺瑯板，板縫與固定螺絲清楚可見。
 */
export function wallPanel(): CanvasTexture {
  return make(
    'wall',
    192,
    512,
    (g) => {
      const H = 512;
      const dado = H * (1 - 0.9 / 3.2);
      g.fillStyle = C.bone;
      g.fillRect(0, 0, 192, H);
      // 上段琺瑯的輕微明暗（越往上越亮）
      const grad = g.createLinearGradient(0, 0, 0, dado);
      grad.addColorStop(0, 'rgba(255,255,255,0.18)');
      grad.addColorStop(1, 'rgba(36,39,41,0.05)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 192, dado);
      // 下段護牆
      g.fillStyle = C.fog;
      g.fillRect(0, dado, 192, H - dado);
      // 分隔條
      g.fillStyle = C.ink;
      g.fillRect(0, dado - 5, 192, 5);
      // 板縫
      g.fillStyle = 'rgba(36,39,41,0.55)';
      g.fillRect(0, 0, 2, H);
      g.fillRect(0, dado * 0.5, 192, 1.5);
      // 螺絲
      g.fillStyle = 'rgba(36,39,41,0.45)';
      for (const y of [10, dado * 0.5 - 8, dado * 0.5 + 8, dado - 16]) {
        g.fillRect(10, y, 3, 3);
        g.fillRect(179, y, 3, 3);
      }
      grain(g, 192, H, 900, 0.035, 7);
    },
    true,
  );
}

/** 地板：1m 方格的霧灰水磨石，縫線炭黑 */
export function floorTile(): CanvasTexture {
  return make(
    'floor',
    256,
    256,
    (g) => {
      g.fillStyle = '#A3A49E';
      g.fillRect(0, 0, 256, 256);
      grain(g, 256, 256, 2600, 0.08, 3);
      g.strokeStyle = 'rgba(36,39,41,0.55)';
      g.lineWidth = 2;
      g.strokeRect(1, 1, 254, 254);
    },
    true,
  );
}

/** 天花板：骨白吸音板 */
export function ceilingTile(): CanvasTexture {
  return make(
    'ceil',
    128,
    128,
    (g) => {
      g.fillStyle = '#D9D6CC';
      g.fillRect(0, 0, 128, 128);
      grain(g, 128, 128, 500, 0.05, 11);
      g.strokeStyle = 'rgba(36,39,41,0.35)';
      g.lineWidth = 2;
      g.strokeRect(1, 1, 126, 126);
    },
    true,
  );
}

/** 單色 CRT：炭黑玻璃、骨白磷光掃描線與幾行無意義的資料列（不含任何線索） */
export function crtScreen(seed: number, on: boolean): CanvasTexture {
  return make(`crt:${seed}:${on}`, 256, 192, (g) => {
    g.fillStyle = '#1B1E1F';
    g.fillRect(0, 0, 256, 192);
    if (on) {
      g.fillStyle = 'rgba(232,229,220,0.07)';
      for (let y = 0; y < 192; y += 3) g.fillRect(0, y, 256, 1);
      const r = rng(seed * 31 + 5);
      g.fillStyle = 'rgba(232,229,220,0.82)';
      for (let i = 0; i < 8; i++) {
        let x = 18;
        const y = 20 + i * 19;
        const words = 1 + Math.floor(r() * 4);
        for (let j = 0; j < words; j++) {
          const w = 10 + r() * 46;
          if (x + w > 238) break;
          g.fillRect(x, y, w, 6);
          x += w + 8;
        }
      }
      // 游標
      g.fillRect(18, 20 + 8 * 19, 8, 10);
    }
    // 弧形玻璃的暗角
    const v = g.createRadialGradient(128, 96, 40, 128, 96, 150);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = v;
    g.fillRect(0, 0, 256, 192);
  });
}

/** 設備銘牌：左邊編號、右邊名稱 */
export function devicePlate(code: string, label: string): CanvasTexture {
  return make(`plate:${code}:${label}`, 512, 112, (g) => {
    g.fillStyle = C.bone;
    g.fillRect(0, 0, 512, 112);
    g.strokeStyle = C.ink;
    g.lineWidth = 6;
    g.strokeRect(3, 3, 506, 106);
    g.fillStyle = C.ink;
    g.fillRect(3, 3, 150, 106);
    g.fillStyle = C.bone;
    g.font = `600 46px ${MONO}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(code, 78, 58);
    g.fillStyle = C.ink;
    g.font = `700 44px ${SANS}`;
    g.textAlign = 'left';
    let size = 44;
    while (g.measureText(label).width > 330 && size > 26) {
      size -= 2;
      g.font = `700 ${size}px ${SANS}`;
    }
    g.fillText(label, 172, 58);
  });
}

/** 區域標示：牆上的大字（例如「A 維修室」） */
export function zoneSign(letter: string, label: string): CanvasTexture {
  return make(`zone:${letter}:${label}`, 512, 256, (g) => {
    g.clearRect(0, 0, 512, 256);
    g.fillStyle = C.ink;
    g.font = `600 220px ${MONO}`;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillText(letter, 4, 214);
    g.fillRect(170, 60, 6, 150);
    g.font = `700 64px ${SANS}`;
    g.fillText(label, 200, 140);
    g.font = `500 30px ${MONO}`;
    g.fillStyle = 'rgba(36,39,41,0.7)';
    g.fillText(`SECTOR ${letter}`, 202, 196);
  });
}

/** 角色胸牌（隊友外觀） */
export function rolePlate(letter: string): CanvasTexture {
  return make(`role:${letter}`, 128, 128, (g) => {
    g.fillStyle = C.bone;
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = C.ink;
    g.lineWidth = 8;
    g.strokeRect(4, 4, 120, 120);
    g.fillStyle = C.ink;
    g.font = `600 92px ${MONO}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(letter, 64, 70);
  });
}

/** 隊友名牌 */
export function nameTexture(text: string): CanvasTexture {
  return make(`name:${text}`, 384, 80, (g) => {
    g.fillStyle = 'rgba(232,229,220,0.94)';
    g.fillRect(2, 10, 380, 60);
    g.strokeStyle = C.ink;
    g.lineWidth = 3;
    g.strokeRect(2, 10, 380, 60);
    g.fillStyle = C.ink;
    g.font = `600 34px ${SANS}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 192, 41);
  });
}

/** 接觸陰影（烘焙式的假陰影，放在設備底下） */
export function contactShadow(): Texture {
  return make('shadow', 128, 128, (g) => {
    const r = g.createRadialGradient(64, 64, 10, 64, 64, 64);
    r.addColorStop(0, 'rgba(36,39,41,0.7)');
    r.addColorStop(0.5, 'rgba(36,39,41,0.38)');
    r.addColorStop(1, 'rgba(36,39,41,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 128, 128);
  });
}

/** 牆腳陰影：沿牆的線性漸層 */
export function wallShadow(): Texture {
  return make('wallshadow', 8, 64, (g) => {
    const l = g.createLinearGradient(0, 0, 0, 64);
    l.addColorStop(0, 'rgba(36,39,41,0.42)');
    l.addColorStop(1, 'rgba(36,39,41,0)');
    g.fillStyle = l;
    g.fillRect(0, 0, 8, 64);
  });
}

/** 紙本檔案（文件櫃上的紙張） */
export function paperSheet(seed: number): CanvasTexture {
  return make(`paper:${seed}`, 128, 160, (g) => {
    g.fillStyle = '#F1EEE6';
    g.fillRect(0, 0, 128, 160);
    const r = rng(seed + 17);
    g.fillStyle = 'rgba(36,39,41,0.55)';
    g.fillRect(12, 14, 60, 6);
    for (let i = 0; i < 11; i++) g.fillRect(12, 34 + i * 10, 40 + r() * 64, 2);
    g.strokeStyle = 'rgba(36,39,41,0.35)';
    g.strokeRect(0.5, 0.5, 127, 159);
  });
}

/** 打孔卡 */
export function punchCard(seed: number): CanvasTexture {
  return make(`punch:${seed}`, 192, 88, (g) => {
    g.fillStyle = '#E9DFC6';
    g.fillRect(0, 0, 192, 88);
    g.fillStyle = 'rgba(36,39,41,0.85)';
    const r = rng(seed + 3);
    for (let col = 0; col < 22; col++) {
      for (let row = 0; row < 6; row++) if (r() > 0.78) g.fillRect(10 + col * 8, 14 + row * 11, 4, 7);
    }
    // 左上角切角（打孔卡的方向記號）
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(14, 0);
    g.lineTo(0, 14);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  });
}

/** 房間標示：大號房間編號＋房間名稱（例如「R04 無窗迷宮」） */
export function roomSign(code: string, label: string): CanvasTexture {
  return make(`room:${code}:${label}`, 640, 256, (g) => {
    g.clearRect(0, 0, 640, 256);
    g.fillStyle = C.ink;
    g.font = `600 150px ${MONO}`;
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.fillText(code, 6, 186);
    const x = 6 + g.measureText(code).width + 26;
    g.fillRect(x, 58, 6, 150);
    g.font = `700 62px ${SANS}`;
    g.fillText(label, x + 30, 140);
    g.font = `500 28px ${MONO}`;
    g.fillStyle = 'rgba(36,39,41,0.7)';
    g.fillText('FACILITY 01', x + 32, 194);
  });
}

/** 門洞楣上的標示（I–IV、1–4、標籤字母） */
export function markPlate(text: string, inverted = false): CanvasTexture {
  return make(`mark:${text}:${inverted}`, 256, 128, (g) => {
    g.fillStyle = inverted ? C.ink : C.bone;
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = inverted ? C.bone : C.ink;
    g.lineWidth = 8;
    g.strokeRect(4, 4, 248, 120);
    g.fillStyle = inverted ? C.bone : C.ink;
    g.font = `600 84px ${MONO}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 70);
  });
}

/** 符號板（○ △ □ ◇）：lit＝亮起（骨白底、炭黑符號），否則為霧面熄滅 */
export function symbolPlate(id: 'TRI' | 'CIR' | 'SQR' | 'DIA', lit: boolean): CanvasTexture {
  return make(`sym:${id}:${lit}`, 128, 128, (g) => {
    g.fillStyle = lit ? '#F6F4EE' : '#5A5D5E';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = lit ? C.ink : '#6E7174';
    g.lineWidth = 10;
    g.beginPath();
    if (id === 'CIR') g.arc(64, 64, 38, 0, Math.PI * 2);
    else if (id === 'SQR') g.rect(28, 28, 72, 72);
    else if (id === 'TRI') {
      g.moveTo(64, 22);
      g.lineTo(106, 100);
      g.lineTo(22, 100);
      g.closePath();
    } else {
      g.moveTo(64, 18);
      g.lineTo(108, 64);
      g.lineTo(64, 110);
      g.lineTo(20, 64);
      g.closePath();
    }
    g.stroke();
  });
}
