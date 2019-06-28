import { Assets } from '..';
import { degrees, PDFDocument, rgb, StandardFonts } from '../../..';

export default async (assets: Assets) => {
  const { pdfs, images } = assets;

  const pdfDoc = PDFDocument.load(pdfs.with_update_sections);

  const helveticaFont = pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const catRidingUnicornImage = pdfDoc.embedJpg(images.jpg.cat_riding_unicorn);
  const catRidingUnicornDims = catRidingUnicornImage.scale(0.13);

  const page0 = pdfDoc.insertPage(0, [305, 250]);
  const page1 = pdfDoc.getPages()[1];
  const page2 = pdfDoc.addPage([305, 125]);

  const hotPink = rgb(1, 0, 1);
  const red = rgb(1, 0, 0);

  page0.drawText('This is the new first page!', {
    x: 5,
    y: 200,
    font: helveticaFont,
    color: hotPink,
  });
  page0.drawImage(catRidingUnicornImage, {
    ...catRidingUnicornDims,
    x: 30,
    y: 30,
  });

  const lastPageText = 'This is the last page!';
  const lastPageTextWidth = helveticaFont.widthOfTextAtSize(lastPageText, 24);

  const page1Text = 'pdf-lib is awesome!';
  const page1TextWidth = helveticaFont.widthOfTextAtSize(page1Text, 70);
  page1.setFontSize(70);
  page1.drawText('pdf-lib is awesome!', {
    x: page1.getWidth() / 2 - page1TextWidth / 2 + 45,
    y: page1.getHeight() / 2 + 45,
    color: red,
    rotate: degrees(-30),
    xSkew: degrees(15),
    ySkew: degrees(15),
  });

  page2.setFontSize(24);
  page2.drawText('This is the last page!', {
    x: 30,
    y: 60,
    font: helveticaFont,
    color: hotPink,
  });
  page2.drawRectangle({
    x: 30,
    y: 50,
    width: lastPageTextWidth,
    height: 5,
    color: hotPink,
  });

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
};