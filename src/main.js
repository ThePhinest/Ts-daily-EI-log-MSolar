import firebase from 'firebase/compat/app'
import 'firebase/compat/auth'
import 'firebase/compat/firestore'
import 'firebase/compat/storage'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import * as exifr from 'exifr'
import * as docx from 'docx'
import './sw-register.js'
import './maps.js'
import './photos.js'

window.firebase = firebase
window.mapboxgl = mapboxgl
window.exifr = exifr
window.docx = docx
