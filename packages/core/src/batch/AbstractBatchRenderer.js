import { BatchDrawCall, BatchTextureArray } from './BatchDrawCall';
import { BaseTexture } from '../textures/BaseTexture';
import { ObjectRenderer } from './ObjectRenderer';
import { State } from '../state/State';
import { ViewableBuffer } from '../geometry/ViewableBuffer';

import { checkMaxIfStatementsInShader } from '../shader/utils/checkMaxIfStatementsInShader';

import { settings } from '@pixi/settings';
import { premultiplyBlendMode, premultiplyTint, nextPow2, log2 } from '@pixi/utils';
import { ENV } from '@pixi/constants';

/**
 * Renderer dedicated to drawing and batching sprites.
 *
 * This is the default batch renderer. It buffers objects
 * with texture-based geometries and renders them in
 * batches. It uploads multiple textures to the GPU to
 * reduce to the number of draw calls.
 *
 * @class
 * @protected
 * @memberof PIXI
 * @extends PIXI.ObjectRenderer
 */
export class AbstractBatchRenderer extends ObjectRenderer
{
    /**
     * This will hook onto the renderer's `contextChange`
     * and `prerender` signals.
     *
     * @param {PIXI.Renderer} renderer - The renderer this works for.
     */
    constructor(renderer)
    {
        super(renderer);

        /**
         * This is used to generate a shader that can
         * color each vertex based on a `aTextureId`
         * attribute that points to an texture in `uSampler`.
         *
         * This enables the objects with different textures
         * to be drawn in the same draw call.
         *
         * You can customize your shader by creating your
         * custom shader generator.
         *
         * @member {PIXI.BatchShaderGenerator}
         * @protected
         */
        this.shaderGenerator = null;

        /**
         * The class that represents the geometry of objects
         * that are going to be batched with this.
         *
         * @member {object}
         * @default PIXI.BatchGeometry
         * @protected
         */
        this.geometryClass = null;

        /**
         * Size of data being buffered per vertex in the
         * attribute buffers (in floats). By default, the
         * batch-renderer plugin uses 6:
         *
         * | aVertexPosition | 2 |
         * |-----------------|---|
         * | aTextureCoords  | 2 |
         * | aColor          | 1 |
         * | aTextureId      | 1 |
         *
         * @member {number}
         * @readonly
         */
        this.vertexSize = null;

        /**
         * The WebGL state in which this renderer will work.
         *
         * @member {PIXI.State}
         * @readonly
         */
        this.state = State.for2d();

        /**
         * The number of bufferable objects before a flush
         * occurs automatically.
         *
         * @member {number}
         * @default settings.SPRITE_BATCH_SIZE * 4
         */
        this.size = settings.SPRITE_BATCH_SIZE * 4;

        /**
         * Total count of all vertices used by the currently
         * buffered objects.
         *
         * @member {number}
         * @private
         */
        this._vertexCount = 0;

        /**
         * Total count of all indices used by the currently
         * buffered objects.
         *
         * @member {number}
         * @private
         */
        this._indexCount = 0;

        /**
         * Buffer of objects that are yet to be rendered.
         *
         * @member {PIXI.DisplayObject[]}
         * @private
         */
        this._bufferedElements = [];

        this._bufferedTextures = [];

        /**
         * Number of elements that are buffered and are
         * waiting to be flushed.
         *
         * @member {number}
         * @private
         */
        this._bufferSize = 0;

        /**
         * This shader is generated by `this.shaderGenerator`.
         *
         * It is generated specifically to handle the required
         * number of textures being batched together.
         *
         * @member {PIXI.Shader}
         * @protected
         */
        this._shader = null;

        /**
         * Pool of `this.geometryClass` geometry objects
         * that store buffers. They are used to pass data
         * to the shader on each draw call.
         *
         * These are never re-allocated again, unless a
         * context change occurs; however, the pool may
         * be expanded if required.
         *
         * @member {PIXI.Geometry[]}
         * @private
         * @see PIXI.AbstractBatchRenderer.contextChange
         */
        this._packedGeometries = [];

        /**
         * Size of `this._packedGeometries`. It can be expanded
         * if more than `this._packedGeometryPoolSize` flushes
         * occur in a single frame.
         *
         * @member {number}
         * @private
         */
        this._packedGeometryPoolSize = 2;

        /**
         * A flush may occur multiple times in a single
         * frame. On iOS devices or when
         * `settings.CAN_UPLOAD_SAME_BUFFER` is false, the
         * batch renderer does not upload data to the same
         * `WebGLBuffer` for performance reasons.
         *
         * This is the index into `packedGeometries` that points to
         * geometry holding the most recent buffers.
         *
         * @member {number}
         * @private
         */
        this._flushId = 0;

        /**
         * Pool of `ViewableBuffer` objects that are sorted in
         * order of increasing size. The flush method uses
         * the buffer with the least size above the amount
         * it requires. These are used for passing attributes.
         *
         * The first buffer has a size of 8; each subsequent
         * buffer has double capacity of its previous.
         *
         * @member {PIXI.ViewableBuffer}
         * @private
         * @see PIXI.AbstractBatchRenderer#getAttributeBuffer
         */
        this._aBuffers = {};

        /**
         * Pool of `Uint16Array` objects that are sorted in
         * order of increasing size. The flush method uses
         * the buffer with the least size above the amount
         * it requires. These are used for passing indices.
         *
         * The first buffer has a size of 12; each subsequent
         * buffer has double capacity of its previous.
         *
         * @member {Uint16Array[]}
         * @private
         * @see PIXI.AbstractBatchRenderer#getIndexBuffer
         */
        this._iBuffers = {};

        /**
         * Maximum number of textures that can be uploaded to
         * the GPU under the current context. It is initialized
         * properly in `this.contextChange`.
         *
         * @member {number}
         * @see PIXI.AbstractBatchRenderer#contextChange
         * @readonly
         */
        this.MAX_TEXTURES = 1;

        this.initFlushBuffers();

        this.renderer.on('prerender', this.onPrerender, this);
        renderer.runners.contextChange.add(this);
    }

    initFlushBuffers()
    {
        /**
         * Pool of `BatchDrawCall` objects that `flush` used
         * to create "batches" of the objects being rendered.
         *
         * These are never re-allocated again.
         *
         * @member {PIXI.BatchDrawCall[]}
         * @private
         */
        this._drawCalls = [];

        /**
         *
         * @member {PIXI.BatchTextureArray[]}
         * @private
         */
        this._textureArrays = [];

        // @popelyshev: There are 4k objects and 2k arrays per batched renderer by default.
        // @popelyshev: @mat Can we do something about it?
        // initialize the draw-calls pool to max size.
        for (let k = 0; k < this.size / 4; k++)
        {
            this._drawCalls[k] = new BatchDrawCall();
            this._textureArrays[k] = new BatchTextureArray();
        }

        this._tempBoundTextures = [];

        this._dcIndex = 0;
        this._aIndex = 0;
        this._iIndex = 0;
        this._attributeBuffer = null;
        this._indexBuffer = null;
    }

    /**
     * Handles the `contextChange` signal.
     *
     * It calculates `this.MAX_TEXTURES` and allocating the
     * packed-geometry object pool.
     */
    contextChange()
    {
        const gl = this.renderer.gl;

        if (settings.PREFER_ENV === ENV.WEBGL_LEGACY)
        {
            this.MAX_TEXTURES = 1;
        }
        else
        {
            // step 1: first check max textures the GPU can handle.
            this.MAX_TEXTURES = Math.min(
                gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
                settings.SPRITE_MAX_TEXTURES);

            // step 2: check the maximum number of if statements the shader can have too..
            this.MAX_TEXTURES = checkMaxIfStatementsInShader(
                this.MAX_TEXTURES, gl);
        }

        this._shader = this.shaderGenerator.generateShader(this.MAX_TEXTURES);

        // we use the second shader as the first one depending on your browser
        // may omit aTextureId as it is not used by the shader so is optimized out.
        for (let i = 0; i < this._packedGeometryPoolSize; i++)
        {
            /* eslint-disable max-len */
            this._packedGeometries[i] = new (this.geometryClass)();
        }

        for (let i = 0; i < this.MAX_TEXTURES; i++)
        {
            this._tempBoundTextures[i] = null;
        }
    }

    /**
     * Handles the `prerender` signal.
     *
     * It ensures that flushes start from the first geometry
     * object again.
     */
    onPrerender()
    {
        this._flushId = 0;
    }

    /**
     * Buffers the "batchable" object. It need not be rendered
     * immediately.
     *
     * @param {PIXI.DisplayObject} element - the element to render when
     *    using this renderer
     */
    render(element)
    {
        if (!element._texture.valid)
        {
            return;
        }

        if (this._vertexCount + (element.vertexData.length / 2) > this.size)
        {
            this.flush();
        }

        this._vertexCount += element.vertexData.length / 2;
        this._indexCount += element.indices.length;
        this._bufferedTextures[this._bufferSize] = element._texture.baseTexture;
        this._bufferedElements[this._bufferSize++] = element;
    }

    buildTexturesAndDrawCalls()
    {
        const {
            _bufferedTextures: textures,
            _textureArrays: textureArrays,
            MAX_TEXTURES,
        } = this;

        const batch = this.renderer.batch;
        const boundTextures = this._tempBoundTextures;
        const touch = this.renderer.textureGC.count;

        let TICK = ++BaseTexture._globalBatch;
        let countTexArrays = 0;
        let texArray = textureArrays[0];
        let start = 0;

        batch.copyBoundTextures(boundTextures, MAX_TEXTURES);

        for (let i = 0; i < this._bufferSize; ++i)
        {
            const tex = textures[i];

            textures[i] = null;
            if (tex._batchEnabled === TICK)
            {
                continue;
            }

            if (texArray.count >= MAX_TEXTURES)
            {
                batch.boundArray(texArray, boundTextures, TICK, MAX_TEXTURES);
                this.buildDrawCalls(texArray, start, i);
                start = i;
                texArray = textureArrays[++countTexArrays];
                ++TICK;
            }

            tex._batchEnabled = TICK;
            tex.touched = touch;
            texArray.elements[texArray.count++] = tex;
        }

        if (texArray.count > 0)
        {
            batch.boundArray(texArray, boundTextures, TICK, MAX_TEXTURES);
            this.buildDrawCalls(texArray, start, this._bufferSize);
            ++countTexArrays;
            ++TICK;
        }

        BaseTexture._globalBatch = TICK;
    }

    /**
     * Populating drawcalls for rendering
     *
     * @param {PIXI.BatchTextureArray} texArray
     * @param {number} start
     * @param {number} finish
     */
    buildDrawCalls(texArray, start, finish)
    {
        const {
            _bufferedElements: elements,
            _drawCalls: drawCalls,
        } = this;

        let dcIndex = this._dcIndex;

        let drawCall = drawCalls[dcIndex];

        drawCall.texArray = texArray;
        drawCall.blend = -1;

        for (let i = start; i < finish; ++i)
        {
            const sprite = elements[i];
            const tex = sprite._texture.baseTexture;
            const spriteBlendMode = premultiplyBlendMode[
                tex.alphaMode ? 1 : 0][sprite.blendMode];

            if (start > i && drawCall.blend !== spriteBlendMode)
            {
                drawCall.start = this._iIndex;
                this.packInterleavedGeometry(start, i);
                drawCall.size = this._iIndex - drawCall.start;

                start = i;
                drawCall = drawCalls[++dcIndex];
                drawCall.texArray = texArray;
            }

            drawCall.blend = spriteBlendMode;
        }

        if (drawCall.start < finish)
        {
            drawCall.start = this._iIndex;
            this.packInterleavedGeometry(start, finish);
            drawCall.size = this._iIndex - drawCall.start;
            ++dcIndex;
        }

        this._dcIndex = dcIndex;
    }

    /**
     * Bind textures for current rendering
     *
     * @param {PIXI.BatchTextureArray} texArray
     */
    bindAndClearTexArray(texArray)
    {
        const textureSystem = this.renderer.texture;

        for (let j = 0; j < texArray.count; j++)
        {
            textureSystem.bind(texArray.elements[j], texArray.ids[j]);
            texArray.elements[j] = null;
        }
        texArray.count = 0;
    }

    updateGeometry()
    {
        const {
            _packedGeometries: packedGeometries,
            _attributeBuffer: attributeBuffer,
            _indexBuffer: indexBuffer,
        } = this;

        if (!settings.CAN_UPLOAD_SAME_BUFFER)
        { /* Usually on iOS devices, where the browser doesn't
            like uploads to the same buffer in a single frame. */
            if (this._packedGeometryPoolSize <= this._flushId)
            {
                this._packedGeometryPoolSize++;
                packedGeometries[this._flushId] = new (this.geometryClass)();
            }

            packedGeometries[this._flushId]._buffer.update(attributeBuffer.rawBinaryData);
            packedGeometries[this._flushId]._indexBuffer.update(indexBuffer);

            this.renderer.geometry.bind(packedGeometries[this._flushId]);
            this.renderer.geometry.updateBuffers();
            this._flushId++;
        }
        else
        {
            // lets use the faster option, always use buffer number 0
            packedGeometries[this._flushId]._buffer.update(attributeBuffer.rawBinaryData);
            packedGeometries[this._flushId]._indexBuffer.update(indexBuffer);

            this.renderer.geometry.updateBuffers();
        }
    }

    drawBatches()
    {
        const dcCount = this._dcIndex;
        const { gl, state: stateSystem } = this.renderer;
        let curTexArray = null;

        // Upload textures and do the draw calls
        for (let i = 0; i < dcCount; i++)
        {
            const { texArray, type, size, start, blend } = this._drawCalls[i];

            if (curTexArray !== texArray)
            {
                curTexArray = texArray;
                this.bindAndClearTexArray(texArray);
            }

            stateSystem.setBlendMode(blend);
            gl.drawElements(type, size, gl.UNSIGNED_SHORT, start * 2);
        }
    }

    /**
     * Renders the content _now_ and empties the current batch.
     */
    flush()
    {
        if (this._vertexCount === 0)
        {
            return;
        }

        this._attributeBuffer = this.getAttributeBuffer(this._vertexCount);
        this._indexBuffer = this.getIndexBuffer(this._indexCount);
        this._aIndex = 0;
        this._iIndex = 0;
        this._dcIndex = 0;

        this.buildTexturesAndDrawCalls();
        this.updateGeometry();
        this.drawBatches();

        // reset elements for the next flush
        this._bufferSize = 0;
        this._vertexCount = 0;
        this._indexCount = 0;
    }

    /**
     * Starts a new sprite batch.
     */
    start()
    {
        this.renderer.state.set(this.state);

        this.renderer.shader.bind(this._shader);

        if (settings.CAN_UPLOAD_SAME_BUFFER)
        {
            // bind buffer #0, we don't need others
            this.renderer.geometry.bind(this._packedGeometries[this._flushId]);
        }
    }

    /**
     * Stops and flushes the current batch.
     */
    stop()
    {
        this.flush();
    }

    /**
     * Destroys this `AbstractBatchRenderer`. It cannot be used again.
     */
    destroy()
    {
        for (let i = 0; i < this._packedGeometryPoolSize; i++)
        {
            if (this._packedGeometries[i])
            {
                this._packedGeometries[i].destroy();
            }
        }

        this.renderer.off('prerender', this.onPrerender, this);

        this._aBuffers = null;
        this._iBuffers = null;
        this._packedGeometries = null;
        this._drawCalls = null;

        if (this._shader)
        {
            this._shader.destroy();
            this._shader = null;
        }

        super.destroy();
    }

    /**
     * Fetches an attribute buffer from `this._aBuffers` that
     * can hold atleast `size` floats.
     *
     * @param {number} size - minimum capacity required
     * @return {ViewableBuffer} - buffer than can hold atleast `size` floats
     * @private
     */
    getAttributeBuffer(size)
    {
        // 8 vertices is enough for 2 quads
        const roundedP2 = nextPow2(Math.ceil(size / 8));
        const roundedSizeIndex = log2(roundedP2);
        const roundedSize = roundedP2 * 8;

        if (this._aBuffers.length <= roundedSizeIndex)
        {
            this._iBuffers.length = roundedSizeIndex + 1;
        }

        let buffer = this._aBuffers[roundedSize];

        if (!buffer)
        {
            this._aBuffers[roundedSize] = buffer = new ViewableBuffer(roundedSize * this.vertexSize * 4);
        }

        return buffer;
    }

    /**
     * Fetches an index buffer from `this._iBuffers` that can
     * has atleast `size` capacity.
     *
     * @param {number} size - minimum required capacity
     * @return {Uint16Array} - buffer that can fit `size`
     *    indices.
     * @private
     */
    getIndexBuffer(size)
    {
        // 12 indices is enough for 2 quads
        const roundedP2 = nextPow2(Math.ceil(size / 12));
        const roundedSizeIndex = log2(roundedP2);
        const roundedSize = roundedP2 * 12;

        if (this._iBuffers.length <= roundedSizeIndex)
        {
            this._iBuffers.length = roundedSizeIndex + 1;
        }

        let buffer = this._iBuffers[roundedSizeIndex];

        if (!buffer)
        {
            this._iBuffers[roundedSizeIndex] = buffer = new Uint16Array(roundedSize);
        }

        return buffer;
    }

    /**
     * Takes the range and packs all data from `this._bufferedElements`
     *
     * It uses these properties: `vertexData` `uvs`, `textureId` and
     * `indicies`. It also uses the "tint" of the base-texture, if
     * present.
     *
     * Current location for textures is taken from `baseTexture._batchLocation`.
     *
     * @param {number} start - first element to pack in geometry
     * @param {number} finish - end element to pack in geometry
     */
    packInterleavedGeometry(start, finish)
    {
        const {
            _attributeBuffer: attributeBuffer,
            _bufferedElements: elements,
            _indexBuffer: indexBuffer,
        } = this;
        const {
            uint32View,
            float32View,
        } = attributeBuffer;

        let aIndex = this._aIndex;
        let iIndex = this._iIndex;
        let packedVertices = aIndex / this.vertexSize;

        for (let j = start; j < finish; j++)
        {
            const element = elements[j];
            const { uvs, indices, vertexData, worldAlpha, _tintRGB } = element;
            const { _batchLocation, alphaMode } = element._texture.baseTexture;
            const alpha = Math.min(worldAlpha, 1.0);
            const argb = (alpha < 1.0 && alphaMode) ? premultiplyTint(_tintRGB, alpha) : _tintRGB + (alpha * 255 << 24);

            // lets not worry about tint! for now..
            for (let i = 0; i < vertexData.length; i += 2)
            {
                float32View[aIndex++] = vertexData[i];
                float32View[aIndex++] = vertexData[i + 1];
                float32View[aIndex++] = uvs[i];
                float32View[aIndex++] = uvs[i + 1];
                uint32View[aIndex++] = argb;
                float32View[aIndex++] = _batchLocation;
            }

            for (let i = 0; i < indices.length; i++)
            {
                indexBuffer[iIndex++] = packedVertices + indices[i];
            }

            packedVertices += vertexData.length / 2;
            elements[j] = null;
        }

        this._aIndex = aIndex;
        this._iIndex = iIndex;
    }
}
