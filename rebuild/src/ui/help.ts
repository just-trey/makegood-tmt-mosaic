import { h } from './dom';

export function helpContent(): HTMLElement {
  const p = (t: string) => h('p', {}, t);
  return h(
    'div',
    { class: 'body' },
    h('h3', {}, 'Start here'),
    p('Pick a part, drop in an SVG or a picture, drag it into place, export a 3MF. Open that file in Bambu Studio, OrcaSlicer or Snapmaker Orca: every color already has its filament slot.'),
    p('Each flat color in the design becomes a pocket cut into the part. The pocket is filled by a second object in that color, so the surface prints flush. The part itself prints in the body color.'),
    p('Your work saves itself as you go. Reload the page and you are offered it back.'),
    h('h3', {}, 'Part'),
    p('Wheel, Hubcap, Footrest or Chair body. The chair has eight design surfaces; pick one here to aim the view at it. A design you load lands on that surface.'),
    p('The hubcap is built at the size you type. Cut to design outline replaces the round disc with the shape of your design, clips kept. It needs a design with a transparent background.'),
    p('Download template gives you the surface at true size, with the joins between printed pieces dashed. Draw over it in Inkscape or Affinity, keep the document size, and load the result: it lands 1:1.'),
    h('h3', {}, 'Design'),
    p('SVG: use flat fill colors. Gradient and pattern fills are skipped, and the tool tells you which. Strokes are not cut; convert them to filled shapes in your editor.'),
    p('PNG, JPG, WebP, GIF, BMP: the picture is reduced to flat colors and traced. Colors sets how many. Detail sets the smallest speck worth keeping. Both apply when you let go of the slider.'),
    p('Sticker places the design once. Fill repeats it across the surface as tiles; the design’s own size is the tile size, Scale changes it, Gap spaces them out. Mirror cuts a reflected copy on the paired surface, or across the centre line where there is no pair.'),
    h('h3', {}, 'Fit'),
    p('Drag inside the frame to move the design. Drag a corner to scale it. Drag the green handle to rotate it (hold Shift for 15° steps). The sliders do the same with numbers. An amber frame means the design has slid off the surface.'),
    h('h3', {}, 'Depth and colors'),
    p('Depth is how far each color is cut into the surface. One depth for all, or a different one per slot. 0 is raised to 0.2 mm, one layer. Where the wall under a design is thin, the pocket is made shallower there and you are told.'),
    p('Auto-merge groups colors that look alike so they share one filament slot. Drag-free version: use Merge with… on a row, or × on a swatch to pull it back out. → body prints a color as the part itself instead of cutting it.'),
    p('The line under the list counts slots including the body. Each AMS or toolhead unit holds 4.'),
    h('h3', {}, 'Export'),
    p('Choose the printer and export. Each printed piece is one object with its body and its colored pockets as parts, each on its slot. Print settings are set for Generic PETG, 15% gyroid infill, tree supports, no brim.'),
    p('The design surface goes face down on the plate: the pocket floors and their fillings share the first layer, the flattest surface a printer makes.'),
    h('h3', {}, 'What was not checked on a printer'),
    p('Plate layout, part orientation and prime tower positions are computed by this tool, not verified on a real machine. Look them over in the slicer before you print. The tool says so in the export warnings every time.'),
  );
}
