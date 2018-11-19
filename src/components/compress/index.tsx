import { h, Component } from 'preact';

import { bind, Fileish } from '../../lib/initial-util';
import { blobToImg, drawableToImageData, blobToText } from '../../lib/util';
import * as style from './style.scss';
import Output from '../Output';
import Options from '../Options';
import ResultCache from './result-cache';
import * as identity from '../../codecs/identity/encoder-meta';
import * as optiPNG from '../../codecs/optipng/encoder-meta';
import * as mozJPEG from '../../codecs/mozjpeg/encoder-meta';
import * as webP from '../../codecs/webp/encoder-meta';
import * as browserPNG from '../../codecs/browser-png/encoder-meta';
import * as browserJPEG from '../../codecs/browser-jpeg/encoder-meta';
import * as browserWebP from '../../codecs/browser-webp/encoder-meta';
import * as browserGIF from '../../codecs/browser-gif/encoder-meta';
import * as browserTIFF from '../../codecs/browser-tiff/encoder-meta';
import * as browserJP2 from '../../codecs/browser-jp2/encoder-meta';
import * as browserBMP from '../../codecs/browser-bmp/encoder-meta';
import * as browserPDF from '../../codecs/browser-pdf/encoder-meta';
import {
    EncoderState,
    EncoderType,
    EncoderOptions,
    encoderMap,
} from '../../codecs/encoders';
import {
  PreprocessorState,
  defaultPreprocessorState,
} from '../../codecs/preprocessors';
import { decodeImage } from '../../codecs/decoders';
import { cleanMerge, cleanSet } from '../../lib/clean-modify';
import Processor from '../../codecs/processor';
import { VectorResizeOptions, BitmapResizeOptions } from '../../codecs/resize/processor-meta';
import './custom-els/MultiPanel';
import Results from '../results';
import { ExpandIcon, CopyAcrossIconProps } from '../../lib/icons';
import SnackBarElement from 'src/lib/SnackBar';

export interface SourceImage {
  file: File | Fileish;
  data: ImageData;
  vectorImage?: HTMLImageElement;
}

interface SideSettings {
  preprocessorState: PreprocessorState;
  encoderState: EncoderState;
}

interface Side {
  preprocessed?: ImageData;
  file?: Fileish;
  downloadUrl?: string;
  data?: ImageData;
  latestSettings: SideSettings;
  encodedSettings?: SideSettings;
  loading: boolean;
  /** Counter of the latest bmp currently encoding */
  loadingCounter: number;
  /** Counter of the latest bmp encoded */
  loadedCounter: number;
}

interface Props {
  file: File | Fileish;
  showSnack: SnackBarElement['showSnackbar'];
  onBack: () => void;
}

interface State {
  source?: SourceImage;
  sides: [Side, Side];
  /** Source image load */
  loading: boolean;
  loadingCounter: number;
  error?: string;
  mobileView: boolean;
}

interface UpdateImageOptions {
  skipPreprocessing?: boolean;
}

async function preprocessImage(
  source: SourceImage,
  preprocessData: PreprocessorState,
  processor: Processor,
): Promise<ImageData> {
  let result = source.data;
  if (preprocessData.rotateFlip.enabled) {
    result = await processor.rotateFlip(result, preprocessData.rotateFlip);
  }
  if (preprocessData.resize.enabled) {
    if (preprocessData.resize.method === 'vector' && source.vectorImage) {
      result = processor.vectorResize(
        source.vectorImage,
        preprocessData.resize as VectorResizeOptions,
      );
    } else {
      result = processor.resize(result, preprocessData.resize as BitmapResizeOptions);
    }
  }
  if (preprocessData.quantizer.enabled) {
    result = await processor.imageQuant(result, preprocessData.quantizer);
  }
  return result;
}

async function compressImage(
  image: ImageData,
  encodeData: EncoderState,
  sourceFilename: string,
  processor: Processor,
): Promise<Fileish> {
  const compressedData = await (() => {
    switch (encodeData.type) {
      case optiPNG.type: return processor.optiPngEncode(image, encodeData.options);
      case mozJPEG.type: return processor.mozjpegEncode(image, encodeData.options);
      case webP.type: return processor.webpEncode(image, encodeData.options);
      case browserPNG.type: return processor.browserPngEncode(image);
      case browserJPEG.type: return processor.browserJpegEncode(image, encodeData.options);
      case browserWebP.type: return processor.browserWebpEncode(image, encodeData.options);
      case browserGIF.type: return processor.browserGifEncode(image);
      case browserTIFF.type: return processor.browserTiffEncode(image);
      case browserJP2.type: return processor.browserJp2Encode(image);
      case browserBMP.type: return processor.browserBmpEncode(image);
      case browserPDF.type: return processor.browserPdfEncode(image);
      default: throw Error(`Unexpected encoder ${JSON.stringify(encodeData)}`);
    }
  })();

  const encoder = encoderMap[encodeData.type];

  return new Fileish(
    [compressedData],
    sourceFilename.replace(/.[^.]*$/, `.${encoder.extension}`),
    { type: encoder.mimeType },
  );
}

async function processSvg(blob: Blob): Promise<HTMLImageElement> {
  // Firefox throws if you try to draw an SVG to canvas that doesn't have width/height.
  // In Chrome it loads, but drawImage behaves weirdly.
  // This function sets width/height if it isn't already set.
  const parser = new DOMParser();
  const text = await blobToText(blob);
  const document = parser.parseFromString(text, 'image/svg+xml');
  const svg = document.documentElement!;

  if (svg.hasAttribute('width') && svg.hasAttribute('height')) {
    return blobToImg(blob);
  }

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox === null) throw Error('SVG must have width/height or viewBox');

  const viewboxParts = viewBox.split(/\s+/);
  svg.setAttribute('width', viewboxParts[2]);
  svg.setAttribute('height', viewboxParts[3]);

  const serializer = new XMLSerializer();
  const newSource = serializer.serializeToString(document);
  return blobToImg(new Blob([newSource], { type: 'image/svg+xml' }));
}

// These are only used in the mobile view
const resultTitles = ['Top', 'Bottom'];
// These are only used in the desktop view
const buttonPositions =
  ['download-left', 'download-right'] as ('download-left' | 'download-right')[];

export default class Compress extends Component<Props, State> {
  widthQuery = window.matchMedia('(max-width: 599px)');

  state: State = {
    source: undefined,
    loading: false,
    loadingCounter: 0,
    sides: [
      {
        latestSettings: {
          preprocessorState: defaultPreprocessorState,
          encoderState: { type: identity.type, options: identity.defaultOptions },
        },
        loadingCounter: 0,
        loadedCounter: 0,
        loading: false,
      },
      {
        latestSettings: {
          preprocessorState: defaultPreprocessorState,
          encoderState: { type: mozJPEG.type, options: mozJPEG.defaultOptions },
        },
        loadingCounter: 0,
        loadedCounter: 0,
        loading: false,
      },
    ],
    mobileView: this.widthQuery.matches,
  };

  private readonly encodeCache = new ResultCache();
  private readonly leftProcessor = new Processor();
  private readonly rightProcessor = new Processor();

  constructor(props: Props) {
    super(props);
    this.widthQuery.addListener(this.onMobileWidthChange);
    this.updateFile(props.file);

    import('../../lib/offliner').then(({ mainAppLoaded }) => mainAppLoaded());
  }

  @bind
  private onMobileWidthChange() {
    this.setState({ mobileView: this.widthQuery.matches });
  }

  private onEncoderTypeChange(index: 0 | 1, newType: EncoderType): void {
    this.setState({
      sides: cleanSet(this.state.sides, `${index}.latestSettings.encoderState`, {
        type: newType,
        options: encoderMap[newType].defaultOptions,
      }),
    });
  }

  private onPreprocessorOptionsChange(index: 0 | 1, options: PreprocessorState): void {
    this.setState({
      sides: cleanSet(this.state.sides, `${index}.latestSettings.preprocessorState`, options),
    });
  }

  private onEncoderOptionsChange(index: 0 | 1, options: EncoderOptions): void {
    this.setState({
      sides: cleanSet(this.state.sides, `${index}.latestSettings.encoderState.options`, options),
    });
  }

  componentWillReceiveProps(nextProps: Props): void {
    if (nextProps.file !== this.props.file) {
      this.updateFile(nextProps.file);
    }
  }

  componentDidUpdate(prevProps: Props, prevState: State): void {
    const { source, sides } = this.state;

    for (const [i, side] of sides.entries()) {
      const prevSettings = prevState.sides[i].latestSettings;
      const sourceChanged = source !== prevState.source;
      const encoderChanged = side.latestSettings.encoderState !== prevSettings.encoderState;
      const preprocessorChanged =
        side.latestSettings.preprocessorState !== prevSettings.preprocessorState;

      // The image only needs updated if the encoder/preprocessor settings have changed, or the
      // source has changed.
      if (sourceChanged || encoderChanged || preprocessorChanged) {
        this.updateImage(i, {
          skipPreprocessing: !sourceChanged && !preprocessorChanged,
        }).catch((err) => {
          console.error(err);
        });
      }
    }
  }

  private async onCopyToOtherClick(index: 0 | 1) {
    const otherIndex = (index + 1) % 2;
    const oldSettings = this.state.sides[otherIndex];

    this.setState({
      sides: cleanSet(this.state.sides, otherIndex, this.state.sides[index]),
    });

    const result = await this.props.showSnack('Settings copied across', {
      timeout: 5000,
      actions: ['undo', 'dismiss'],
    });

    if (result !== 'undo') return;

    this.setState({
      sides: cleanSet(this.state.sides, otherIndex, oldSettings),
    });
  }

  @bind
  private async updateFile(file: File | Fileish) {
    const loadingCounter = this.state.loadingCounter + 1;

    this.setState({ loadingCounter, loading: true });

    // Abort any current encode jobs, as they're redundant now.
    this.leftProcessor.abortCurrent();
    this.rightProcessor.abortCurrent();

    try {
      let data: ImageData;
      let vectorImage: HTMLImageElement | undefined;

      // Special-case SVG. We need to avoid createImageBitmap because of
      // https://bugs.chromium.org/p/chromium/issues/detail?id=606319.
      // Also, we cache the HTMLImageElement so we can perform vector resizing later.
      if (file.type.startsWith('image/svg+xml')) {
        vectorImage = await processSvg(file);
        data = drawableToImageData(vectorImage);
      } else {
        // Either processor is good enough here.
        data = await decodeImage(file, this.leftProcessor);
      }

      // Another file has been opened before this one processed.
      if (this.state.loadingCounter !== loadingCounter) return;

      let newState: State = {
        ...this.state,
        source: { data, file, vectorImage },
        loading: false,
      };

      for (const i of [0, 1]) {
        // Ditch previous encodings
        const downloadUrl = this.state.sides[i].downloadUrl;
        if (downloadUrl) URL.revokeObjectURL(downloadUrl!);

        newState = cleanMerge(newState, `sides.${i}`, {
          preprocessed: undefined,
          file: undefined,
          downloadUrl: undefined,
          data: undefined,
          encodedSettings: undefined,
        });

        // Default resize values come from the image:
        newState = cleanMerge(newState, `sides.${i}.latestSettings.preprocessorState.resize`, {
          width: data.width,
          height: data.height,
          method: vectorImage ? 'vector' : 'browser-high',
        });
      }

      this.setState(newState);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      // Another file has been opened before this one processed.
      if (this.state.loadingCounter !== loadingCounter) return;
      this.props.showSnack('Invalid image');
      this.setState({ loading: false });
    }
  }

  private async updateImage(index: number, options: UpdateImageOptions = {}): Promise<void> {
    const { skipPreprocessing = false } = options;
    const { source } = this.state;
    if (!source) return;

    // Each time we trigger an async encode, the counter changes.
    const loadingCounter = this.state.sides[index].loadingCounter + 1;

    let sides = cleanMerge(this.state.sides, index, {
      loadingCounter,
      loading: true,
    });

    this.setState({ sides });

    const side = sides[index];
    const settings = side.latestSettings;

    let file: File | Fileish | undefined;
    let preprocessed: ImageData | undefined;
    let data: ImageData | undefined;
    const cacheResult = this.encodeCache.match(
      source, settings.preprocessorState, settings.encoderState,
    );
    const processor = (index === 0) ? this.leftProcessor : this.rightProcessor;

    // Abort anything the processor is currently doing.
    // Although the processor will abandon current tasks when a new one is called,
    // we might not call another task here. Eg, we might get the result from the cache.
    processor.abortCurrent();

    if (cacheResult) {
      ({ file, preprocessed, data } = cacheResult);
    } else {
      try {
        // Special case for identity
        if (settings.encoderState.type === identity.type) {
          ({ file, data } = source);
        } else {
          preprocessed = (skipPreprocessing && side.preprocessed)
            ? side.preprocessed
            : await preprocessImage(source, settings.preprocessorState, processor);

          file = await compressImage(
            preprocessed, settings.encoderState, source.file.name, processor,
          );
          data = await decodeImage(file, processor);

          this.encodeCache.add({
            source,
            data,
            preprocessed,
            file,
            encoderState: settings.encoderState,
            preprocessorState: settings.preprocessorState,
          });
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        this.props.showSnack(`Processing error (type=${settings.encoderState.type}): ${err}`);
        throw err;
      }
    }

    const latestData = this.state.sides[index];
    // If a later encode has landed before this one, return.
    if (loadingCounter < latestData.loadedCounter) {
      return;
    }

    if (latestData.downloadUrl) URL.revokeObjectURL(latestData.downloadUrl);

    sides = cleanMerge(this.state.sides, index, {
      file,
      data,
      preprocessed,
      downloadUrl: URL.createObjectURL(file),
      loading: sides[index].loadingCounter !== loadingCounter,
      loadedCounter: loadingCounter,
      encodedSettings: settings,
    });

    this.setState({ sides });
  }

  render({ onBack }: Props, { loading, sides, source, mobileView }: State) {
    const [leftSide, rightSide] = sides;
    const [leftImageData, rightImageData] = sides.map(i => i.data);

    const options = sides.map((side, index) => (
      <Options
        source={source}
        mobileView={mobileView}
        preprocessorState={side.latestSettings.preprocessorState}
        encoderState={side.latestSettings.encoderState}
        onEncoderTypeChange={this.onEncoderTypeChange.bind(this, index)}
        onEncoderOptionsChange={this.onEncoderOptionsChange.bind(this, index)}
        onPreprocessorOptionsChange={this.onPreprocessorOptionsChange.bind(this, index)}
      />
    ));

    const copyDirections =
      (mobileView ? ['down', 'up'] : ['right', 'left']) as CopyAcrossIconProps['copyDirection'][];

    const results = sides.map((side, index) => (
      <Results
        downloadUrl={side.downloadUrl}
        imageFile={side.file}
        source={source}
        loading={loading || side.loading}
        copyDirection={copyDirections[index]}
        onCopyToOtherClick={this.onCopyToOtherClick.bind(this, index)}
        buttonPosition={mobileView ? 'stack-right' : buttonPositions[index]}
      >
        {!mobileView ? null : [
          <ExpandIcon class={style.expandIcon} key="expand-icon"/>,
          `${resultTitles[index]} (${encoderMap[side.latestSettings.encoderState.type].label})`,
        ]}
      </Results>
    ));

    // For rendering, we ideally want the settings that were used to create the data, not the latest
    // settings.
    const leftDisplaySettings = leftSide.encodedSettings || leftSide.latestSettings;
    const rightDisplaySettings = rightSide.encodedSettings || rightSide.latestSettings;
    const leftImgContain = leftDisplaySettings.preprocessorState.resize.enabled &&
      leftDisplaySettings.preprocessorState.resize.fitMethod === 'contain';
    const rightImgContain = rightDisplaySettings.preprocessorState.resize.enabled &&
      rightDisplaySettings.preprocessorState.resize.fitMethod === 'contain';
    const leftFlipDimensions = leftDisplaySettings.preprocessorState.rotateFlip.enabled &&
      leftDisplaySettings.preprocessorState.rotateFlip.rotate % 180 !== 0;
    const rightFlipDimensions = rightDisplaySettings.preprocessorState.rotateFlip.enabled &&
      rightDisplaySettings.preprocessorState.rotateFlip.rotate % 180 !== 0;

    return (
      <div class={style.compress}>
        <Output
          originalImage={source && source.data}
          mobileView={mobileView}
          leftCompressed={leftImageData}
          rightCompressed={rightImageData}
          leftImgContain={leftImgContain}
          rightImgContain={rightImgContain}
          leftFlipDimensions={leftFlipDimensions}
          rightFlipDimensions={rightFlipDimensions}
          onBack={onBack}
        />
        {mobileView
          ? (
            <div class={style.options}>
              <multi-panel class={style.multiPanel} open-one-only>
                {results[0]}
                {options[0]}
                {results[1]}
                {options[1]}
              </multi-panel>
            </div>
          ) : ([
            <div class={style.options} key="options0">
              {options[0]}
              {results[0]}
            </div>,
            <div class={style.options} key="options1">
              {options[1]}
              {results[1]}
            </div>,
          ])
        }
      </div>
    );
  }
}
