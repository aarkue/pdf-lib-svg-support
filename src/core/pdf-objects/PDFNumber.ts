import _ from 'lodash';

import { addStringToBuffer } from 'utils';
import { validate } from 'utils/validate';

import PDFObject from './PDFObject';

class PDFNumber extends PDFObject {
  static fromNumber = (num: number) => new PDFNumber(num);
  static fromString = (numberStr: string) => new PDFNumber(Number(numberStr));

  number: number;

  constructor(num: number) {
    super();
    validate(num, _.isNumber, 'Can only construct PDFNumbers from Numbers');
    this.number = num;
  }

  toString = (): string => this.number.toString();

  bytesSize = () => this.toString().length;

  copyBytesInto = (buffer: Uint8Array): Uint8Array =>
    addStringToBuffer(this.toString(), buffer);
}

export default PDFNumber;
