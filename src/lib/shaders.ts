export const baseVertexShader = `
precision highp float;
attribute vec2 aPosition;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform vec2 uTexelSize;

void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(uTexelSize.x, 0.0);
    vR = vUv + vec2(uTexelSize.x, 0.0);
    vT = vUv + vec2(0.0, uTexelSize.y);
    vB = vUv - vec2(0.0, uTexelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const advectionShader = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexelSize;
uniform float uDt;
uniform float uDissipation;

void main() {
    vec2 vel = texture2D(uVelocity, vUv).xy;
    vec2 prevUV = vUv - vel * uDt * uTexelSize;
    gl_FragColor = uDissipation * texture2D(uSource, prevUV);
}
`;

export const divergenceShader = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

export const pressureShader = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexelSize;

void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float div = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - div) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

export const gradientSubtractShader = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 vel = texture2D(uVelocity, vUv).xy;
    vel -= 0.5 * vec2(R - L, T - B);
    gl_FragColor = vec4(vel, 0.0, 1.0);
}
`;

export const curlShader = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
uniform vec2 uTexelSize;

void main() {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float curl = R - L - T + B;
    gl_FragColor = vec4(curl, 0.0, 0.0, 1.0);
}
`;

export const vorticityShader = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uStrength;
uniform float uDt;
uniform vec2 uTexelSize;

void main() {
    float L = abs(texture2D(uCurl, vL).x);
    float R = abs(texture2D(uCurl, vR).x);
    float T = abs(texture2D(uCurl, vT).x);
    float B = abs(texture2D(uCurl, vB).x);
    float C = texture2D(uCurl, vUv).x;

    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    float len = max(length(force), 1e-5);
    force = force / len * C;
    force.y *= -1.0;

    vec2 vel = texture2D(uVelocity, vUv).xy;
    vel += force * uStrength * uDt;
    gl_FragColor = vec4(vel, 0.0, 1.0);
}
`;

export const splatShader = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uTarget;
uniform float uAspectRatio;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;
uniform float uStrength; 
uniform bool uIsDye;

void main() {
    vec2 p = vUv - uPoint.xy;
    p.x *= uAspectRatio;
    float distSq = dot(p, p);
    float splat = exp(-distSq / (2.0 * uRadius * uRadius));
    float weight = splat * uStrength;
    
    vec4 current = texture2D(uTarget, vUv);
    
    if (uIsDye) {
        float outA = min(current.a + weight, 1.0);
        vec3 outRGB = mix(current.rgb, uColor, weight);
        if (current.a < 0.01) outRGB = uColor;
        gl_FragColor = vec4(outRGB, outA);
    } else {
        vec3 added = uColor * weight;
        float outA = min(current.a + weight, 1.0);
        gl_FragColor = vec4(current.rgb + added, outA);
    }
}
`;

export const displayShader = `
precision highp float;
precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uDye;
uniform vec3 uBackgroundColor;

// Basic Perlin/Simplex noise alternative: pseudo-random noise for paper texture
float rand(vec2 n) { 
    return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453);
}

void main() {
    vec4 ink = texture2D(uDye, vUv);
    
    // Mix ink color with background color based on ink's alpha
    // Ink color is directly the color now, not blown out
    vec3 color = mix(uBackgroundColor, ink.rgb, clamp(ink.a, 0.0, 1.0));
    
    // Add subtle paper texture
    float noise = rand(vUv * 10.0);
    color = mix(color, vec3(noise), 0.015);
    
    gl_FragColor = vec4(color, 1.0);
}
`;
