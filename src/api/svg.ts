import {
  parse as parseHtml,
  HTMLElement,
  Attributes,
  Node,
  NodeType,
} from 'node-html-better-parser';
import { Color, colorString } from './colors';
import { Degrees, degreesToRadians, RotationTypes } from './rotations';
import PDFPage from './PDFPage';
import { PDFPageDrawSVGElementOptions } from './PDFPageOptions';
import { LineCapStyle, LineJoinStyle } from './operators';
import { Rectangle, Point, Segment } from 'src/utils/elements';
import { getIntersections } from 'src/utils/intersections';
import { distanceCoords, isEqual, distance } from 'src/utils/maths';
interface Position {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

type Box = Position & Size;

interface SVGSizeConverter {
  point: (x: number, y: number) => Position;
  size: (w: number, h: number) => Size;
}

type SVGStyle = Record<string, string>;

type InheritedAttributes = {
  width: number;
  height: number;
  fill?: Color;
  fillOpacity?: number;
  stroke?: Color;
  strokeWidth?: number;
  strokeOpacity?: number;
  strokeLineCap?: LineCapStyle;
  strokeLineJoin?: LineJoinStyle;
  fontFamily?: string;
  fontSize?: number;
  rotation?: Degrees;
};
type SVGAttributes = {
  rotate?: Degrees;
  scale?: number;
  skewX?: Degrees;
  skewY?: Degrees;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  cx?: number;
  cy?: number;
  r?: number;
  rx?: number;
  ry?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  d?: string;
  src?: string;
  textAnchor?: string;
  preserveAspectRatio?: string
};

export type SVGElement = HTMLElement & {
  svgAttributes: InheritedAttributes & SVGAttributes;
};

interface SVGElementToDrawMap {
  [cmd: string]: (a: SVGElement) => Promise<void>;
}

const isCoordinateInsideTheRect  = (dot: Point, rect: Rectangle) =>  isEqual(0, distance(dot, rect.orthoProjection(dot)))

const StrokeLineCapMap: Record<string, LineCapStyle> = {
  butt: LineCapStyle.Butt,
  round: LineCapStyle.Round,
  square: LineCapStyle.Projecting,
};

const StrokeLineJoinMap: Record<string, LineJoinStyle> = {
  bevel: LineJoinStyle.Bevel,
  miter: LineJoinStyle.Miter,
  round: LineJoinStyle.Round,
};

/** polyfill for Node < 12 */
const matchAll = (str: string) => (re: RegExp) => {
  const matches = [];
  let groups;
  // tslint:disable-next-line no-conditional-assignment
  while ((groups = re.exec(str))) {
    matches.push(groups);
  }
  return matches;
};

const getInnerSegment = (start: Point, end: Point, rect: Rectangle) => {
  const isStartInside = isCoordinateInsideTheRect(start, rect)
  const isEndInside = isCoordinateInsideTheRect(end, rect)
  let resultLineStart = start
  let resultLineEnd = end
  // it means that the segment is already inside the rect
  if (isEndInside && isStartInside) return new Segment(start, end)

  const line = new Segment(start, end)
  const intersection = getIntersections([rect, line])

  // if there's no intersection it means that the line doesn't intersects the svgRect and isn't visible
  if (intersection.length === 0) return

  if (!isStartInside) {
    // replace the line start point by the nearest intersection
    const nearestPoint = intersection.sort((p1, p2) => distanceCoords(start, p1) - distanceCoords(start, p2))[0]
    resultLineStart = new Point(nearestPoint)
  }

  if (!isEndInside) {
    // replace the line start point by the nearest intersection
    const nearestPoint = intersection.sort((p1, p2) => distanceCoords(end, p1) - distanceCoords(end, p2))[0]
    resultLineEnd = new Point(nearestPoint)
  }
  
  return new Segment(resultLineStart, resultLineEnd)
}

// TODO: Improve type system to require the correct props for each tagName.
/** methods to draw SVGElements onto a PDFPage */
const runnersToPage = (
  svgRect: Rectangle,
  page: PDFPage,
  options: PDFPageDrawSVGElementOptions,
): SVGElementToDrawMap => ({
  async text(element) {
    const anchor = element.svgAttributes.textAnchor;
    const text = element.childNodes[0].text;
    const fontSize = element.svgAttributes.fontSize || 12;
    const textWidth = (text.length * fontSize) / 2; // We try to approx the width of the text
    const offset =
      anchor === 'middle' ? textWidth / 2 : anchor === 'end' ? textWidth : 0;
    const point = new Point({ x: (element.svgAttributes.x || 0) - offset, y:  element.svgAttributes.y || 0 })

    if (isCoordinateInsideTheRect(point, svgRect)) {
      page.drawText(text, {
        x: point.x,
        y: point.y,
        font:
          options.fonts && element.svgAttributes.fontFamily
            ? options.fonts[element.svgAttributes.fontFamily]
            : undefined,
        size: fontSize,
        color: element.svgAttributes.fill,
        opacity: element.svgAttributes.fillOpacity,
        rotate: element.svgAttributes.rotate,
      });
    }
  },
  async line(element) {
    const start =  new Point({
      x: element.svgAttributes.x1!,
      y: element.svgAttributes.y1!,
    })

    const end = new Point({
      x: element.svgAttributes.x2!,
      y: element.svgAttributes.y2!,
    })
    const line = getInnerSegment(start, end, svgRect)
    if (!line) return

    page.drawLine({
      start: line.A.toCoords(),
      end: line.B.toCoords(),
      thickness: element.svgAttributes.strokeWidth,
      color: element.svgAttributes.stroke,
      opacity: element.svgAttributes.strokeOpacity,
      lineCap: element.svgAttributes.strokeLineCap,
    });
  },
  async path(element) {
    // the path origin coordinate
    const basePoint = new Point({x: element.svgAttributes.x || 0, y: element.svgAttributes.y || 0})
    const normalizePoint = (p: Point) => new Point({ x: p.x - basePoint.x, y:  p.y - basePoint.y})

    /**
     * 
     * @param currentPoint is the global point of the current drawing
     * @param command the path instruction 
     * @param params the instrction params
     * @returns the point where the next instruction starts and the new instruction text
     */
    const handlePath = (currentPoint: Point, command: string, params: number[]) => {
      switch(command) {
        case 'm':
        case 'M':
          {
            const nextPoint = new Point({
                x: basePoint.x + params[0],
                y: basePoint.y + params[1]
              })
            return {
              point: nextPoint,
              command: `${command}${params[0]},${params[1]}`
            }
          }
        case 'l':
        case 'L':
          {
            const isLocalInstruction = command === 'l'
            const nextPoint = new Point({
              x: (isLocalInstruction ? currentPoint.x : basePoint.x) + params[0],
              y: (isLocalInstruction ? currentPoint.y : basePoint.y) + params[1],
            })
            const normalizedNext = normalizePoint(nextPoint)

            let endPoint = new Point({ x: nextPoint.x, y: nextPoint.y })
            let startPoint = new Point({ x: currentPoint.x, y: currentPoint.y })
            const result = getInnerSegment(startPoint, endPoint, svgRect)
            
            if (!result) {
              return {
                  point: nextPoint,
                  command: isLocalInstruction ? `M${normalizedNext.x},${normalizedNext.y}` : `M${params[0]},${params[1]}`
                }
            }

            // if the point wasn't moved it means that it's inside the rect
            const isStartInside = result.A.isEqual(startPoint)
            const isEndInside = result.B.isEqual(endPoint)

            // the intersection points are referencing the pdf coordinates, it's necessary to convert these points to the path's origin point
            endPoint = normalizePoint(new Point(result.B.toCoords()))
            startPoint = normalizePoint(new Point(result.A.toCoords()))
            const startInstruction = isStartInside ? '' : `M${startPoint.x},${startPoint.y}`
            const endInstruction = isEndInside ? '' : isLocalInstruction ? `M${normalizedNext.x},${normalizedNext.y}` : `M${params[0]},${params[1]}`
            return {
              point: nextPoint,
              command: `${startInstruction} L${endPoint.x},${endPoint.y} ${endInstruction} `
            }
          }
        // TODO: Handle the remaining svg instructions: v,h,a,t,q,c
        default:
          return {
            point: currentPoint,
            command: `${command} ${params.map(p => `${p}`).join()}`
          }
      }
    }

    const commands = element.svgAttributes.d!.match(/(v|h|a|l|t|m|q|c)([0-9,e\s.-]*)(?=z|v|h|a|l|t|m|q|c)*/gi)
    let currentPoint = new Point({x: basePoint.x, y: basePoint.y })
    const newPath = commands?.map(command => {
      const letter = command.match(/[a-z]/i)?.[0]
      const params = command.match(/([0-9e.-]*)/ig)?.filter(m => m !== '').map(v => parseFloat(v))
      if (letter && params) {
        const result = handlePath(currentPoint, letter, params)
        if (result) {
          currentPoint = result.point
          return result.command
        }
      }
      return command
    }).join(' ')

    // See https://jsbin.com/kawifomupa/edit?html,output and
    page.drawSvgPath(newPath!, {
      x: element.svgAttributes.x || 0,
      y: element.svgAttributes.y || 0,
      borderColor: element.svgAttributes.stroke,
      borderWidth: element.svgAttributes.strokeWidth,
      borderOpacity: element.svgAttributes.strokeOpacity,
      borderLineCap: element.svgAttributes.strokeLineCap,
      color: element.svgAttributes.fill,
      opacity: element.svgAttributes.fillOpacity,
      scale: element.svgAttributes.scale,
      rotate: element.svgAttributes.rotate,
    });
  },
  async image(element) {
    const img = await page.doc.embedPng(element.svgAttributes.src!)
    const { x, y, width, height } = getFittingRectangle(
      img.width,
      img.height,
      element.svgAttributes.width || img.width,
      element.svgAttributes.height || img.height,
      element.svgAttributes.preserveAspectRatio
    )
    page.drawImage(img, {
      x: (element.svgAttributes.x || 0) + x,
      y: (element.svgAttributes.y || 0) - y - height,
      width,
      height,
      opacity: element.svgAttributes.fillOpacity,
      xSkew: element.svgAttributes.skewX,
      ySkew: element.svgAttributes.skewY,
      rotate: element.svgAttributes.rotate,
    });
  },
  async rect(element) {
    if (!element.svgAttributes.fill && !element.svgAttributes.stroke) return;
    page.drawRectangle({
      x: element.svgAttributes.x,
      y: (element.svgAttributes.y || 0),
      width: element.svgAttributes.width,
      height: element.svgAttributes.height * -1,
      borderColor: element.svgAttributes.stroke,
      borderWidth: element.svgAttributes.strokeWidth,
      borderOpacity: element.svgAttributes.strokeOpacity,
      borderLineCap: element.svgAttributes.strokeLineCap,
      color: element.svgAttributes.fill,
      opacity: element.svgAttributes.fillOpacity,
      xSkew: element.svgAttributes.skewX,
      ySkew: element.svgAttributes.skewY,
      rotate: element.svgAttributes.rotate,
    });
  },
  async ellipse(element) {
    page.drawEllipse({
      x: element.svgAttributes.cx,
      y: element.svgAttributes.cy,
      xScale: element.svgAttributes.rx,
      yScale: element.svgAttributes.ry,
      borderColor: element.svgAttributes.stroke,
      borderWidth: element.svgAttributes.strokeWidth,
      borderOpacity: element.svgAttributes.strokeOpacity,
      borderLineCap: element.svgAttributes.strokeLineCap,
      color: element.svgAttributes.fill,
      opacity: element.svgAttributes.fillOpacity,
      rotate: element.svgAttributes.rotate,
    });
  },
  async circle(element) {
    return runnersToPage(svgRect, page, options).ellipse(element);
  },
});

const transform = (
  converter: SVGSizeConverter,
  name: string,
  args: number[],
): SVGSizeConverter => {
  switch (name) {
    case 'scaleX':
      return transform(converter, 'scale', [args[0], 0]);
    case 'scaleY':
      return transform(converter, 'scale', [0, args[0]]);
    case 'scale':
      const [xScale, yScale = xScale] = args;
      return {
        point: (x: number, y: number) =>
          converter.point(x * xScale, y * yScale),
        size: (w: number, h: number) =>
          converter.size(w * xScale, h * yScale)
      };
    case 'translateX':
      return transform(converter, 'translate', [args[0], 0]);
    case 'translateY':
      return transform(converter, 'translate', [0, args[0]]);
    case 'translate':
      const [dx, dy = dx] = args;
      return {
        point: (x: number, y: number) => converter.point(x + dx, y + dy),
        size: converter.size,
      };
    case 'rotate': {
      if (args.length > 1) {
        const [a, x, y = x] = args;
        let tempResult = transform(converter, 'translate', [-x, -y]);
        tempResult = transform(tempResult, 'rotate', [a]);
        return transform(tempResult, 'translate', [x, y]);
      } else {
        const [a] = args;
        const angle = degreesToRadians(a);
        return {
          point: (x, y) =>
            converter.point(
              x * Math.cos(angle) - y * Math.sin(angle),
              y * Math.cos(angle) + x * Math.sin(angle),
            ),
          size: (w, h) =>
            converter.size(
              w * Math.cos(angle) - h * Math.sin(angle),
              h * Math.cos(angle) + w * Math.sin(angle),
            ),
        };
      }
    }
    case 'skewX': {
      const angle = degreesToRadians(args[0]);
      return {
        point: (x: number, y: number) =>
          converter.point((1 + x) * Math.tan(angle), y),
        size: converter.size,
      };
    }
    case 'skewY': {
      const angle = degreesToRadians(args[0]);
      return {
        point: (x: number, y: number) =>
          converter.point(x, (1 + y) * Math.tan(angle)),
        size: converter.size,
      };
    }
    default: {
      console.log('transformation unsupported:', name);
      return converter;
    }
  }
};

const styleOrAttribute = (
  attributes: Attributes,
  style: SVGStyle,
  attribute: string,
  def?: string,
): string => {
  const value = style[attribute] || attributes[attribute];
  if (!value && typeof def !== 'undefined') return def;
  return value;
};

const parseStyles = (style: string): SVGStyle => {
  const cssRegex = /([^:\s]+)*\s*:\s*([^;]+)/g;
  const css: SVGStyle = {};
  let match = cssRegex.exec(style);
  while (match != null) {
    css[match[1]] = match[2];
    match = cssRegex.exec(style);
  }
  return css;
};

const parseColor = (
  color: string,
): { rgb: Color; alpha?: string } | undefined => {
  if (!color || color.length === 0) return undefined;
  if (['none', 'transparent'].includes(color)) return undefined;
  const parsedColor = colorString(color);
  return {
    rgb: parsedColor.rgb,
    alpha: parsedColor.alpha ? parsedColor.alpha + '' : undefined,
  };
};

type ParsedAttributes = {
  inherited: InheritedAttributes;
  converter: SVGSizeConverter;
  tagName: string;
  svgAttributes: SVGAttributes;
};

const parseAttributes = (
  element: HTMLElement,
  inherited: InheritedAttributes,
  converter: SVGSizeConverter,
): ParsedAttributes => {
  const attributes = element.attributes;
  const style = parseStyles(attributes.style);

  const widthRaw = styleOrAttribute(attributes, style, 'width', '');
  const heightRaw = styleOrAttribute(attributes, style, 'height', '');
  const fillRaw = parseColor(styleOrAttribute(attributes, style, 'fill'));
  const fillOpacityRaw = styleOrAttribute(attributes, style, 'fill-opacity');
  const opacityRaw = styleOrAttribute(attributes, style, 'opacity');
  const strokeRaw = parseColor(styleOrAttribute(attributes, style, 'stroke'));
  const strokeOpacityRaw = styleOrAttribute(
    attributes,
    style,
    'stroke-opacity',
  );
  const strokeLineCapRaw = styleOrAttribute(
    attributes,
    style,
    'stroke-linecap',
  );
  const strokeLineJoinRaw = styleOrAttribute(
    attributes,
    style,
    'stroke-linejoin',
  );
  const strokeWidthRaw = styleOrAttribute(attributes, style, 'stroke-width');
  const fontFamilyRaw = styleOrAttribute(attributes, style, 'font-family');
  const fontSizeRaw = styleOrAttribute(attributes, style, 'font-size');

  const width = parseFloatValue(widthRaw, inherited.width);
  const height = parseFloatValue(heightRaw, inherited.height);
  const x = parseFloatValue(attributes.x, inherited.width);
  const y = parseFloatValue(attributes.y, inherited.height);
  const x1 = parseFloatValue(attributes.x1, inherited.width);
  const x2 = parseFloatValue(attributes.x2, inherited.width);
  const y1 = parseFloatValue(attributes.y1, inherited.height);
  const y2 = parseFloatValue(attributes.y2, inherited.height);
  const cx = parseFloatValue(attributes.cx, inherited.width);
  const cy = parseFloatValue(attributes.cy, inherited.height);
  const rx = parseFloatValue(attributes.rx || attributes.r, inherited.width);
  const ry = parseFloatValue(attributes.ry || attributes.r, inherited.height);

  const newInherited: InheritedAttributes = {
    fontFamily: fontFamilyRaw || inherited.fontFamily,
    fontSize: parseFloatValue(fontSizeRaw) ?? inherited.fontSize,
    fill: fillRaw?.rgb || inherited.fill,
    fillOpacity:
      parseFloatValue(fillOpacityRaw || opacityRaw || fillRaw?.alpha) ??
      inherited.fillOpacity,
    stroke: strokeRaw?.rgb || inherited.stroke,
    strokeWidth: parseFloatValue(strokeWidthRaw) ?? inherited.strokeWidth,
    strokeOpacity:
      parseFloatValue(strokeOpacityRaw || opacityRaw || strokeRaw?.alpha) ??
      inherited.strokeOpacity,
    strokeLineCap:
      StrokeLineCapMap[strokeLineCapRaw] || inherited.strokeLineCap,
    strokeLineJoin:
      StrokeLineJoinMap[strokeLineJoinRaw] || inherited.strokeLineJoin,
    width: width || inherited.width,
    height: height || inherited.height,
  };

  const svgAttributes: SVGAttributes = {
    src: attributes.src || attributes['xlink:href'],
    textAnchor: attributes['text-anchor'],
    preserveAspectRatio: attributes.preserveAspectRatio
  };

  let newConverter = converter;

  let transformList = attributes.transform || '';
  // Handle transformations set as direct attributes
  [
    'translate',
    'translateX',
    'translateY',
    'skewX',
    'skewY',
    'rotate',
    'scale',
    'scaleX',
    'scaleY',
  ].forEach((name) => {
    if (attributes[name]) {
      transformList = attributes[name] + ' ' + transformList;
    }
  });
  // skewX, skewY, rotate and scale are handled by the pdf-lib
  (['skewX', 'skewY', 'rotate'] as const).forEach((name) => {
    if (attributes[name]) {
      const d = attributes[name].match(/-?(\d+\.?|\.)\d*/)?.[0];
      if (d !== undefined) {
        svgAttributes[name] = {
          angle: parseInt(d, 10),
          type: RotationTypes.Degrees,
        };
      }
    }
  });
  if (attributes.scale) {
    const d = attributes.scale.match(/-?(\d+\.?|\.)\d*/)?.[0];
    if (d !== undefined) svgAttributes.scale = parseInt(d, 10);
  }
  // Convert x/y as if it was a translation
  if (x || y) {
    transformList = `translate(${x || 0} ${y || 0}) ` + transformList;
  }
  // Apply the transformations
  if (transformList) {
    const regexTransform = /(\w+)\((.+?)\)/g;
    let parsed = regexTransform.exec(transformList);
    while (parsed !== null) {
      const [, name, rawArgs] = parsed;
      const args = (rawArgs || '')
        .split(/\s*,\s*|\s+/)
        .filter((value) => value.length > 0)
        .map((value) => parseFloat(value));

      newConverter = transform(newConverter, name, args);
      parsed = regexTransform.exec(transformList);
    }
  }

  // x and y were already transformed into a translation. The new reference point is now 0,0
  const { x: newX, y: newY } = newConverter.point(0, 0);
  svgAttributes.x = newX;
  svgAttributes.y = newY;

  if (attributes.cx || attributes.cy) {
    const { x: newCX, y: newCY } = newConverter.point(cx || 0, cy || 0);
    svgAttributes.cx = newCX;
    svgAttributes.cy = newCY;
  }
  if (attributes.rx || attributes.ry) {
    const { width: newRX, height: newRY } = newConverter.size(rx || 0, ry || 0);
    svgAttributes.rx = newRX;
    svgAttributes.ry = newRY;
  }
  if (attributes.x1 || attributes.y1) {
    const { x: newX1, y: newY1 } = newConverter.point(x1 || 0, y1 || 0);
    svgAttributes.x1 = newX1;
    svgAttributes.y1 = newY1;
  }
  if (attributes.x2 || attributes.y2) {
    const { x: newX2, y: newY2 } = newConverter.point(x2 || 0, y2 || 0);
    svgAttributes.x2 = newX2;
    svgAttributes.y2 = newY2;
  }
  if (attributes.width || attributes.height) {
    const size = converter.size(
      width || inherited.width,
      height || inherited.height,
    );
    svgAttributes.width = size.width;
    svgAttributes.height = size.height;
  }
  // We convert all the points from the path
  if (attributes.d) {
    const { x: xOrigin, y: yOrigin } = converter.point(0, 0);
    // transform v/V and h/H commands
    svgAttributes.d = attributes.d.replace(
      /(v|h)\s*-?(\d+\.?|\.)\d*/gi,
      (elt) => {
        const letter = elt.charAt(0);
        const coord = parseFloatValue(elt.slice(1).trim()) || 1;
        if (letter === letter.toLowerCase()) {
          return letter === 'h'
            ? 'h' + converter.size(coord, 1).width
            : 'v' + converter.size(1, coord).height;
        } else {
          return letter === 'H'
            ? 'H' + (converter.point(coord, 1).x - xOrigin)
            : 'V' + (converter.point(1, coord).y - yOrigin);
        }
      },
    );
    // transform a
    svgAttributes.d = svgAttributes.d.replace(
      /a\s*(((-?\d+\.?|\.)\d*)(,\s*|\s+|(?=-)|$|\D)){1,7}/gi,
      elt => {
        const letter = elt.charAt(0);
        const params = elt.slice(1);
        const [rx, ry, xAxisRotation = '0', largeArc = '0', sweepFlag = '0', x, y] = params.match(/-?(\d+\.?|\.)\d*/g) || []
        const realRx = parseFloatValue(rx, inherited.width) || 0
        const realRy = parseFloatValue(ry, inherited.height) || 0
        const realX = parseFloatValue(x, inherited.width) || 0
        const realY = parseFloatValue(y, inherited.height) || 0
        const { width: newRx, height: newRy } = converter.size(realRx, realRy)
        let newX, newY
        if (letter === letter.toLowerCase()) {
          const { width, height } = converter.size(realX, realY)
          newX = width;
          newY = height
        } else {
          const { x: pX, y: pY } = converter.point(realX, realY)
          newX = pX
          newY = pY
        }
        return [letter, newRx, newRy, xAxisRotation, largeArc, sweepFlag, newX - xOrigin, newY - yOrigin].join(' ')
      }
    )

    // transform other letters
    svgAttributes.d = svgAttributes.d.replace(
      /(l|t|m|q|c)(\s*-?(\d+\.?|\.)\d*(,\s*|\s+|(?=-))-?(\d+\.?|\.)\d*)+/gi,
      (elt) => {
        const letter = elt.charAt(0);
        const coords = elt.slice(1);
        return (
          letter +
          matchAll(coords)(
            /(-?(\d+\.?|\.)\d*)(,\s*|\s+|(?=-))(-?(\d+\.?|\.)\d*)/gi,
          )
            .map(([, a, , , b]) => {
              const xReal = parseFloatValue(a, inherited.width) || 0;
              const yReal = parseFloatValue(b, inherited.height) || 0;
              if (letter === letter.toLowerCase()) {
                const { width: dx, height: dy } = converter.size(xReal, yReal);
                return [dx, -dy].join(',');
              } else {
                const { x: xPixel, y: yPixel } = converter.point(xReal, yReal);
                return [xPixel - xOrigin, yPixel - yOrigin].join(',');
              }
            })
            .join(' ')
        );
      }
    );
  }
  if (attributes.viewBox) {
    const viewBox = parseViewBox(attributes.viewBox)!;
    const size = {
      width: width || inherited.width,
      height: height || inherited.height,
    };
    const localConverter = getConverterWithAspectRatio(
      size,
      viewBox,
      attributes.preserveAspectRatio,
    );
    const oldConverter = newConverter;
    newConverter = {
      point: (px: number, py: number) => {
        const { x: localX, y: localY } = localConverter.point(px, py);
        return oldConverter.point(localX, localY);
      },
      size: (w: number, h: number) => {
        const { width: localWidth, height: localHeight } = localConverter.size(
          w,
          h,
        );
        return oldConverter.size(localWidth, localHeight);
      },
    };
  }
  if (newInherited.fontSize) {
    newInherited.fontSize = newConverter.size(1, newInherited.fontSize).height;
  }
  if (newInherited.fontFamily) {
    // Handle complex fontFamily like `"Linux Libertine O", serif`
    const inner = newInherited.fontFamily.match(/^"(.*?)"|^'(.*?)'/);
    if (inner) newInherited.fontFamily = inner[1] || inner[2];
  }
  
  if (newInherited.strokeWidth) {
    const result = newConverter.size(newInherited.strokeWidth, newInherited.strokeWidth)
    newInherited.strokeWidth = Math.max(Math.min(Math.abs(result.width), Math.abs(result.height)), 1)
  }

  return {
    inherited: newInherited,
    svgAttributes,
    converter: newConverter,
    tagName: element.tagName,
  };
};

const getConverter = (box: Size, viewBox: Box): SVGSizeConverter => {
  const { width, height } = box;
  const { x: xMin, y: yMin, width: viewWidth, height: viewHeight } = viewBox;
  const converter = {
    point: (xReal: number, yReal: number) => ({
      x: ((xReal - xMin) / viewWidth) * (width || 0),
      y: ((yReal - yMin) / viewHeight) * (height || 0),
    }),
    size: (wReal: number, hReal: number) => ({
      width: (wReal / viewWidth) * (width || 0),
      height: (hReal / viewHeight) * (height || 0),
    }),
  };
  return converter;
};

const getConverterWithAspectRatio = (
  size: Size,
  viewBox: Box,
  preserveAspectRatio?: string,
) => {
  const { x, y, width, height } = getFittingRectangle(viewBox.width, viewBox.height, size.width, size.height, preserveAspectRatio)
  const ratioConverter = getConverter({ width, height }, viewBox);
  // We translate the drawing in the page when the aspect ratio is different, according to the preserveAspectRatio instructions.
  return {
    point: (xReal: number, yReal: number) => {
      const P = ratioConverter.point(xReal, yReal)
      return { x: P.x + x, y: P.y + y }
    },
    size: ratioConverter.size
  }
}

const getFittingRectangle = (originalWidth: number, originalHeight: number, targetWidth: number, targetHeight: number, preserveAspectRatio?: string) => {
  if (preserveAspectRatio === 'none') return { x: 0, y: 0, width: targetWidth, height: targetHeight }
  const originalRatio = originalWidth / originalHeight;
  const targetRatio = targetWidth / targetHeight;
  const width = targetRatio > originalRatio ? originalRatio * targetHeight : targetWidth;
  const height = targetRatio >= originalRatio ? targetHeight : targetWidth / originalRatio;
  const dx = targetWidth - width;
  const dy = targetHeight - height;
  const [x, y] = (() => {
    switch (preserveAspectRatio) {
      case 'xMinYMin': return [0, 0];
      case 'xMidYMin': return [dx / 2, 0];
      case 'xMaxYMin': return [dx, dy / 2];
      case 'xMinYMid': return [0, dy];
      case 'xMaxYMid': return [dx, dy / 2];
      case 'xMinYMax': return [0, dy];
      case 'xMidYMax': return [dx / 2, dy];
      case 'xMaxYMax': return [dx, dy];
      case 'xMidYMid':
      default: return [dx / 2, dy / 2];
    }
  })();
  return { x, y, width, height }
}

const parseHTMLNode = (
  node: Node,
  inherited: InheritedAttributes,
  converter: SVGSizeConverter,
): SVGElement[] => {
  if (node.nodeType === NodeType.COMMENT_NODE) return [];
  else if (node.nodeType === NodeType.TEXT_NODE) return [];
  else if (node.tagName === 'g' || node.tagName === 'svg') {
    return parseGroupNode(
      node as HTMLElement & { tagName: 'svg' | 'g' },
      inherited,
      converter,
    );
  } else {
    const attributes = parseAttributes(node, inherited, converter);
    const svgAttributes = {
      ...attributes.inherited,
      ...attributes.svgAttributes,
    };
    Object.assign(node, { svgAttributes });
    return [node as SVGElement];
  }
};

const parseGroupNode = (
  node: HTMLElement & { tagName: 'svg' | 'g' },
  inherited: InheritedAttributes,
  converter: SVGSizeConverter,
): SVGElement[] => {
  const attributes = parseAttributes(node, inherited, converter);
  const result: SVGElement[] = [];
  node.childNodes.forEach((child) =>
    result.push(
      ...parseHTMLNode(child, attributes.inherited, attributes.converter),
    ),
  );
  return result;
};

const parseFloatValue = (value?: string, reference = 1) => {
  if (!value) return undefined;
  const v = parseFloat(value);
  if (isNaN(v)) return undefined;
  if (value.endsWith('%')) return (v * reference) / 100;
  return v;
};

const parseViewBox = (viewBox?: string): Box | undefined => {
  if (!viewBox) return;
  const [xViewBox = 0, yViewBox = 0, widthViewBox = 1, heightViewBox = 1] = (
    viewBox || ''
  )
    .split(' ')
    .map((val) => parseFloatValue(val));
  return {
    x: xViewBox,
    y: yViewBox,
    width: widthViewBox,
    height: heightViewBox,
  };
};

const parse = (
  svg: string,
  { width, height, x, y, fontSize }: PDFPageDrawSVGElementOptions,
  size: Size,
  converter: SVGSizeConverter,
): SVGElement[] => {
  const htmlElement = parseHtml(svg).firstChild as HTMLElement;
  if (width) htmlElement.setAttribute('width', width + '');
  if (height) htmlElement.setAttribute('height', height + '');
  if (x !== undefined) htmlElement.setAttribute('x', x + '');
  if (y !== undefined) htmlElement.setAttribute('y', size.height - y + '');
  if (fontSize) htmlElement.setAttribute('font-size', fontSize + '');
  return parseHTMLNode(htmlElement, size, converter);
};

export const drawSvg = async (
  page: PDFPage,
  svg: string,
  options: PDFPageDrawSVGElementOptions,
) => {
  const size = page.getSize();
  // The y axis of the page is reverted
  const defaultConverter = {
    point: (x: number, y: number) => ({ x, y: size.height - y }),
    size: (w: number, h: number) => ({ width: w, height: h }),
  };
  const firstChild = parseHtml(svg).firstChild as HTMLElement
  const x = options.x !== undefined ? options.x : parseFloat(firstChild.attributes.x)
  const y = options.y !== undefined ? options.y : parseFloat(firstChild.attributes.y)
  const width = options.width !== undefined ? options.width : parseFloat(firstChild.attributes.width)
  const height = options.height !== undefined ? options.height : parseFloat(firstChild.attributes.height)
  const svgRect = new Rectangle(new Point({x, y}), new Point({ x: x + width, y: y - height }))
  const runners = runnersToPage(svgRect, page, options);
  const elements = parse(svg, options, size, defaultConverter);
  elements.forEach((elt) => runners[elt.tagName]?.(elt));
};
