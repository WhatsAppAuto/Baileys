import { MessageType, HKDFInfoKeys, MessageOptions, WAMessageType } from './Constants'
import sharp from 'sharp'
import * as fs from 'fs'
import fetch from 'node-fetch'
import { WAMessage, WAMessageContent } from '../WAConnection/Constants'
import { hmacSign, aesDecryptWithIV, hkdf } from '../WAConnection/Utils'
import { proto } from '../../WAMessage/WAMessage'
import { randomBytes } from 'crypto'
import { exec } from 'child_process'

export function validateJIDForSending (jid: string) {
    const regexp = /^[0-9]{1,20}(-[0-9]{1,20}@g.us|@s.whatsapp.net)$/
    if (!regexp.test (jid)) {
        throw new Error (
            `Invalid WhatsApp id: ${jid}
            1. Please ensure you suffix '@s.whatsapp.net' for individual numbers & '@g.us' for groups
            2. Please do not put any alphabets or special characters like a '+' in the number. A '-' symbol in groups is fine`
        )
    }
}

/** Type of notification */
export function getNotificationType(message: WAMessage): [string, MessageType?] {
    if (message.message) {
        return ['message', Object.keys(message.message)[0] as MessageType]
    } else if (message.messageStubType) {
        return [WAMessageType[message.messageStubType], null]
    } else {
        return ['unknown', null]
    }
}
/** generates all the keys required to encrypt/decrypt & sign a media message */
export function getMediaKeys(buffer, mediaType: MessageType) {
    if (typeof buffer === 'string') {
        buffer = Buffer.from (buffer.replace('data:;base64,', ''), 'base64')
    }
    // expand using HKDF to 112 bytes, also pass in the relevant app info
    const expandedMediaKey = hkdf(buffer, 112, HKDFInfoKeys[mediaType])
    return {
        iv: expandedMediaKey.slice(0, 16),
        cipherKey: expandedMediaKey.slice(16, 48),
        macKey: expandedMediaKey.slice(48, 80),
    }
}
/** Extracts video thumb using FFMPEG */
const extractVideoThumb = async (
    path: string,
    destPath: string,
    time: string,
    size: { width: number; height: number },
) =>
    new Promise((resolve, reject) => {
        const cmd = `ffmpeg -ss ${time} -i ${path} -y -s ${size.width}x${size.height} -vframes 1 -f image2 ${destPath}`
        exec(cmd, (err) => {
            if (err) {
                reject(err)
            } else {
                resolve()
            }
        })
    }) as Promise<void>

export const compressImage = async (buffer: Buffer) => sharp(buffer).resize(48, 48).jpeg().toBuffer()

/** generates a thumbnail for a given media, if required */
export async function generateThumbnail(buffer: Buffer, mediaType: MessageType, info: MessageOptions) {
    if (info.thumbnail === null || info.thumbnail) {
        // don't do anything if the thumbnail is already provided, or is null
        if (mediaType === MessageType.audio) {
            throw new Error('audio messages cannot have thumbnails')
        }
    } else if (mediaType === MessageType.image || mediaType === MessageType.sticker) {
        const buff = await compressImage (buffer)
        info.thumbnail = buff.toString('base64')
    } else if (mediaType === MessageType.video) {
        const filename = './' + randomBytes(5).toString('hex') + '.mp4'
        const imgFilename = filename + '.jpg'
        fs.writeFileSync(filename, buffer)
        try {
            await extractVideoThumb(filename, imgFilename, '00:00:00', { width: 48, height: 48 })
            const buff = fs.readFileSync(imgFilename)
            info.thumbnail = buff.toString('base64')
            fs.unlinkSync(imgFilename)
        } catch (err) {
            console.log('could not generate video thumb: ' + err)
        }
        fs.unlinkSync(filename)
    }
}
/**
 * Decode a media message (video, image, document, audio) & return decrypted buffer
 * @param message the media message you want to decode
 */
export async function decodeMediaMessageBuffer(message: WAMessageContent) {
    /* 
        One can infer media type from the key in the message
        it is usually written as [mediaType]Message. Eg. imageMessage, audioMessage etc.
    */
    const type = Object.keys(message)[0] as MessageType
    if (!type) {
        throw new Error('unknown message type')
    }
    if (type === MessageType.text || type === MessageType.extendedText) {
        throw new Error('cannot decode text message')
    }
    if (type === MessageType.location || type === MessageType.liveLocation) {
        return new Buffer(message[type].jpegThumbnail)
    }
    let messageContent: proto.IVideoMessage | proto.IImageMessage | proto.IAudioMessage | proto.IDocumentMessage
    if (message.productMessage) {
        const product = message.productMessage.product?.productImage
        if (!product) throw new Error ('product has no image')
        messageContent = product
    } else {
        messageContent = message[type]
    }
    
    // download the message
    const fetched = await fetch(messageContent.url, { headers: { Origin: 'https://web.whatsapp.com' } })
    const buffer = await fetched.buffer()

    if (buffer.length === 0) {
        throw new Error ('Empty buffer returned. File has possibly been deleted from WA servers. Run `client.updateMediaMessage()` to refresh the url')
    }

    const decryptedMedia = (type: MessageType) => {
        // get the keys to decrypt the message
        const mediaKeys = getMediaKeys(messageContent.mediaKey, type) //getMediaKeys(Buffer.from(messageContent.mediaKey, 'base64'), type)
        // first part is actual file
        const file = buffer.slice(0, buffer.length - 10)
        // last 10 bytes is HMAC sign of file
        const mac = buffer.slice(buffer.length - 10, buffer.length)
        // sign IV+file & check for match with mac
        const testBuff = Buffer.concat([mediaKeys.iv, file])
        const sign = hmacSign(testBuff, mediaKeys.macKey).slice(0, 10)
        // our sign should equal the mac
        if (sign.equals(mac)) {
            return aesDecryptWithIV(file, mediaKeys.cipherKey, mediaKeys.iv) // decrypt media
        } else {
            throw new Error()
        }
    }
    const allTypes = [type, ...Object.keys(HKDFInfoKeys)]
    for (let i = 0; i < allTypes.length;i++) {
        try {
            const decrypted = decryptedMedia (allTypes[i] as MessageType)
            
            if (i > 0) { console.log (`decryption of ${type} media with HKDF key of ${allTypes[i]}`) }
            return decrypted
        } catch {
            if (i === 0) { console.log (`decryption of ${type} media with original HKDF key failed`) }
        }
    }
    throw new Error('HMAC sign does not match for ' + buffer.length)
}
/**
 * Decode a media message (video, image, document, audio) & save it to the given file
 * @param message the media message you want to decode
 * @param filename the name of the file where the media will be saved
 * @param attachExtension should the correct extension be applied automatically to the file
 */
export async function decodeMediaMessage(message: WAMessageContent, filename: string, attachExtension: boolean=true) {
    const getExtension = (mimetype) => mimetype.split(';')[0].split('/')[1]
    
    const buffer = await decodeMediaMessageBuffer (message)
    const type = Object.keys(message)[0] as MessageType
    let extension
    if (type === MessageType.location || type === MessageType.liveLocation) {
        extension = '.jpeg'
    } else {
        const messageContent = message[type] as
                                | proto.VideoMessage
                                | proto.ImageMessage
                                | proto.AudioMessage
                                | proto.DocumentMessage
        extension = getExtension (messageContent.mimetype)
    }
    
    const trueFileName = attachExtension ? (filename + '.' + extension) : filename
    fs.writeFileSync(trueFileName, buffer)
    return trueFileName
}

