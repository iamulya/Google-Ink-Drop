import { useEffect, useRef, useState } from 'react';
import { baseVertexShader, advectionShader, divergenceShader, pressureShader, gradientSubtractShader, curlShader, vorticityShader, splatShader, displayShader } from './lib/shaders';
import { getInjectionPoints } from './lib/numbers';

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [currentNumber, setCurrentNumber] = useState<string>('10');
  const [isFinale, setIsFinale] = useState(false);
  const [finaleTextVisible, setFinaleTextVisible] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // We will initialize WebGL here.
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
    if (!gl) {
      console.error('WebGL2 not supported');
      return;
    }

    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear'); // Actually typically available for half float

    const createShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Could not create shader');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        throw new Error('Shader compile error');
      }
      return shader;
    };

    const createProgram = (vertexSource: string, fragmentSource: string) => {
      const program = gl.createProgram();
      if (!program) throw new Error('Could not create program');
      gl.attachShader(program, createShader(gl.VERTEX_SHADER, vertexSource));
      gl.attachShader(program, createShader(gl.FRAGMENT_SHADER, fragmentSource));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
        throw new Error('Program link error');
      }
      return program;
    };

    const programs = {
      advection: createProgram(baseVertexShader, advectionShader),
      divergence: createProgram(baseVertexShader, divergenceShader),
      pressure: createProgram(baseVertexShader, pressureShader),
      gradientSubtract: createProgram(baseVertexShader, gradientSubtractShader),
      curl: createProgram(baseVertexShader, curlShader),
      vorticity: createProgram(baseVertexShader, vorticityShader),
      splat: createProgram(baseVertexShader, splatShader),
      display: createProgram(baseVertexShader, displayShader),
    };

    // Screen quad
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const bindQuad = (program: WebGLProgram) => {
      gl.useProgram(program);
      const positionLoc = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(positionLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
    };

    const createFBO = (w: number, h: number, internalFormat: number, format: number, type: number, param: number) => {
      gl.activeTexture(gl.TEXTURE0);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      return { fbo, texture, width: w, height: h, attach: (id: number) => {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      }};
    };

    const createDoubleFBO = (w: number, h: number, internalFormat: number, format: number, type: number, param: number) => {
      let fbo1 = createFBO(w, h, internalFormat, format, type, param);
      let fbo2 = createFBO(w, h, internalFormat, format, type, param);
      return {
        get read() { return fbo1; },
        get write() { return fbo2; },
        swap() { let temp = fbo1; fbo1 = fbo2; fbo2 = temp; }
      };
    };

    const simRes = 512;
    const dyeRes = 1024;
    const internalFormat = gl.RGBA16F;
    const format = gl.RGBA;
    const type = gl.HALF_FLOAT;

    const velocity = createDoubleFBO(simRes, simRes, internalFormat, format, type, gl.LINEAR);
    const pressure = createDoubleFBO(simRes, simRes, internalFormat, format, type, gl.NEAREST);
    const dye = createDoubleFBO(dyeRes, dyeRes, internalFormat, format, type, gl.LINEAR);
    
    // Divergence & Curl are single FBOs
    const divergence = createFBO(simRes, simRes, internalFormat, format, type, gl.NEAREST);
    const curl = createFBO(simRes, simRes, internalFormat, format, type, gl.NEAREST);

    // Initial setup
    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    const getUniformLoc = (program: WebGLProgram, name: string) => gl.getUniformLocation(program, name);

    const config = {
      dt: 0.016,
      dyeDecay: 0.997,
      velocityDissipation: 0.999,
      pressureIterations: 30,
      vorticity: 8.0,
      radius: 0.003,      // Splat radius (slightly smaller for dense sample points)
      velocitySplat: 40.0, // Initial velocity impulse outward
    };

    let animationFrameId: number;
    let sequenceTime = 0;
    let state = 'INIT'; // INIT, DROP, BLOOM, SETTLE, FADE, FINALE_DROP, FINALE_HOLD
    let currentNum = 10;
    
    // Random function for velocity Splats
    const rand = (min: number, max: number) => Math.random() * (max - min) + min;

    let injectionQueue: { x: number, y: number, color: number[], velocityX: number, velocityY: number, intensity: number }[] = [];

    const splat = (target: any, color: number[], x: number, y: number, radius: number, strength: number, isVelocity: boolean) => {
      bindQuad(programs.splat);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.write.fbo);
      gl.viewport(0, 0, target.write.width, target.write.height);
      
      gl.uniform1i(getUniformLoc(programs.splat, 'uTarget'), target.read.attach(0));
      const aspectRatio = canvas.width / canvas.height;
      gl.uniform1f(getUniformLoc(programs.splat, 'uAspectRatio'), aspectRatio);
      
      gl.uniform2f(getUniformLoc(programs.splat, 'uPoint'), x, y);
      gl.uniform3f(getUniformLoc(programs.splat, 'uColor'), color[0], color[1], color[2]);
      gl.uniform1f(getUniformLoc(programs.splat, 'uRadius'), radius);
      gl.uniform1f(getUniformLoc(programs.splat, 'uStrength'), strength);
      gl.uniform1i(getUniformLoc(programs.splat, 'uIsDye'), isVelocity ? 0 : 1);
      
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      target.swap();
    };

    const runSimulation = () => {
      // 1. Splat queued injections
      for (const inj of injectionQueue) {
        // Dye splat
        splat(dye, inj.color, inj.x, inj.y, config.radius, inj.intensity, false);
        // Velocity splat
        splat(velocity, [inj.velocityX, inj.velocityY, 0], inj.x, inj.y, config.radius, inj.intensity, true);
      }
      injectionQueue = [];

      // 2. Computed Curl
      bindQuad(programs.curl);
      gl.bindFramebuffer(gl.FRAMEBUFFER, curl.fbo);
      gl.viewport(0, 0, curl.width, curl.height);
      gl.uniform1i(getUniformLoc(programs.curl, 'uVelocity'), velocity.read.attach(0));
      gl.uniform2f(getUniformLoc(programs.curl, 'uTexelSize'), 1.0 / simRes, 1.0 / simRes);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 3. Vorticity Confinement
      bindQuad(programs.vorticity);
      gl.bindFramebuffer(gl.FRAMEBUFFER, velocity.write.fbo);
      gl.uniform1i(getUniformLoc(programs.vorticity, 'uVelocity'), velocity.read.attach(0));
      gl.uniform1i(getUniformLoc(programs.vorticity, 'uCurl'), curl.attach(1));
      gl.uniform1f(getUniformLoc(programs.vorticity, 'uStrength'), config.vorticity);
      gl.uniform1f(getUniformLoc(programs.vorticity, 'uDt'), config.dt);
      gl.uniform2f(getUniformLoc(programs.vorticity, 'uTexelSize'), 1.0 / simRes, 1.0 / simRes);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      velocity.swap();

      // 4. Divergence
      bindQuad(programs.divergence);
      gl.bindFramebuffer(gl.FRAMEBUFFER, divergence.fbo);
      gl.uniform1i(getUniformLoc(programs.divergence, 'uVelocity'), velocity.read.attach(0));
      gl.uniform2f(getUniformLoc(programs.divergence, 'uTexelSize'), 1.0 / simRes, 1.0 / simRes);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // 5. Clear Pressure
      gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.read.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // 6. Pressure Solve (Jacobi)
      bindQuad(programs.pressure);
      for (let i = 0; i < config.pressureIterations; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, pressure.write.fbo);
        gl.uniform1i(getUniformLoc(programs.pressure, 'uPressure'), pressure.read.attach(0));
        gl.uniform1i(getUniformLoc(programs.pressure, 'uDivergence'), divergence.attach(1));
        gl.uniform2f(getUniformLoc(programs.pressure, 'uTexelSize'), 1.0 / simRes, 1.0 / simRes);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        pressure.swap();
      }

      // 7. Gradient Subtract
      bindQuad(programs.gradientSubtract);
      gl.bindFramebuffer(gl.FRAMEBUFFER, velocity.write.fbo);
      gl.uniform1i(getUniformLoc(programs.gradientSubtract, 'uPressure'), pressure.read.attach(0));
      gl.uniform1i(getUniformLoc(programs.gradientSubtract, 'uVelocity'), velocity.read.attach(1));
      gl.uniform2f(getUniformLoc(programs.gradientSubtract, 'uTexelSize'), 1.0 / simRes, 1.0 / simRes);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      velocity.swap();

      // 8. Advect Velocity
      bindQuad(programs.advection);
      gl.bindFramebuffer(gl.FRAMEBUFFER, velocity.write.fbo);
      gl.uniform1i(getUniformLoc(programs.advection, 'uVelocity'), velocity.read.attach(0));
      gl.uniform1i(getUniformLoc(programs.advection, 'uSource'), velocity.read.attach(1));
      gl.uniform2f(getUniformLoc(programs.advection, 'uTexelSize'), 1.0 / simRes, 1.0 / simRes);
      gl.uniform1f(getUniformLoc(programs.advection, 'uDt'), config.dt);
      gl.uniform1f(getUniformLoc(programs.advection, 'uDissipation'), config.velocityDissipation);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      velocity.swap();

      // 9. Advect Dye
      bindQuad(programs.advection);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dye.write.fbo);
      gl.viewport(0, 0, dye.read.width, dye.read.height);
      gl.uniform1i(getUniformLoc(programs.advection, 'uVelocity'), velocity.read.attach(0));
      gl.uniform1i(getUniformLoc(programs.advection, 'uSource'), dye.read.attach(1));
      gl.uniform2f(getUniformLoc(programs.advection, 'uTexelSize'), 1.0 / simRes, 1.0 / simRes); // Velocity field sample step
      gl.uniform1f(getUniformLoc(programs.advection, 'uDt'), config.dt);
      gl.uniform1f(getUniformLoc(programs.advection, 'uDissipation'), config.dyeDecay);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      dye.swap();

      // 10. Display Render
      bindQuad(programs.display);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1i(getUniformLoc(programs.display, 'uDye'), dye.read.attach(0));
      gl.uniform3f(getUniformLoc(programs.display, 'uBackgroundColor'), 1.0, 1.0, 1.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const googleColors = [
      [0.26, 0.52, 0.96], // Blue 
      [0.92, 0.26, 0.21], // Red
      [1.00, 0.74, 0.02], // Yellow
      [0.20, 0.66, 0.33]  // Green
    ];

    const injectShape = (numStr: string, intensityMult = 1.0) => {
      const pts = getInjectionPoints(numStr);
      
      const minDim = Math.min(canvas.width, canvas.height);
      const scaleX = (minDim * 0.6) / canvas.width;
      const scaleY = (minDim * 0.6) / canvas.height;
      
      pts.forEach((p, i) => {
        // Map to UV space (0 to 1) centering the number
        const ux = 0.5 + p.x * scaleX; 
        const uy = 0.5 + p.y * scaleY;

        // Radial velocity out from center (0.5, 0.5)
        let vx = ux - 0.5;
        let vy = uy - 0.5;
        const len = Math.sqrt(vx*vx + vy*vy) || 1;
        vx = (vx / len) * config.velocitySplat + rand(-30, 30);
        vy = (vy / len) * config.velocitySplat + rand(-30, 30);
        
        // Use all Google colors cyclically per sample point
        const colorRgb = googleColors[i % googleColors.length];

        injectionQueue.push({
          x: ux + rand(-0.005, 0.005),
          y: uy + rand(-0.005, 0.005),
          color: colorRgb,
          velocityX: vx,
          velocityY: vy,
          intensity: rand(0.7, 1.0) * intensityMult
        });
      });
    };

    let lastTime = performance.now();
    
    const update = (time: number) => {
      // Delta time in seconds
      const dtElapsed = Math.min((time - lastTime) / 1000, 0.033);
      lastTime = time;
      
      if (state !== 'FINALE_HOLD' && state !== 'INIT') {
        sequenceTime += dtElapsed;
      }

      if (state === 'INIT') {
         setCurrentNumber('10');
         state = 'DROP';
         sequenceTime = 0;
      } 
      else if (state === 'DROP') {
         // Progressive intensity over 0.15s. Scale injection by dtElapsed to keep it framerate independent.
         const progress = Math.min(sequenceTime / 0.15, 1.0);
         if (currentNum >= 1) {
            // Apply 0 to 1 intensity ramp, scaled by dtElapsed * 60 (to normalize roughly around 1.0 for 60fps)
            injectShape(currentNum.toString(), progress * (dtElapsed * 60) * 1.5);
         }
         config.dyeDecay = 0.995;
         if (sequenceTime >= 0.15) {
             state = 'BLOOM';
         }
      } 
      else if (state === 'BLOOM') {
         config.dyeDecay = 0.99;
         if (sequenceTime >= 0.5) {
            state = 'SETTLE';
         }
      }
      else if (state === 'SETTLE') {
         config.dyeDecay = 0.98;
         if (sequenceTime >= 0.7) {
             state = 'FADE';
         }
      }
      else if (state === 'FADE') {
         config.dyeDecay = 0.65; // Extremely fast decay so it completely disappears within the second
         if (sequenceTime >= 0.95) {
            // Completely clear the FBOs so the canvas is pristine white for the next number
            gl.bindFramebuffer(gl.FRAMEBUFFER, dye.read.fbo);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.bindFramebuffer(gl.FRAMEBUFFER, dye.write.fbo);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.bindFramebuffer(gl.FRAMEBUFFER, velocity.read.fbo);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.bindFramebuffer(gl.FRAMEBUFFER, velocity.write.fbo);
            gl.clear(gl.COLOR_BUFFER_BIT);
         }
         if (sequenceTime >= 1.0) {
            // Next number
            currentNum--;
            if (currentNum > 0) {
               setCurrentNumber(currentNum.toString());
               state = 'DROP';
               sequenceTime = 0;
            } else {
               // Finale
               state = 'FINALE_DROP';
               sequenceTime = 0;
               setIsFinale(true);
            }
         }
      }
      else if (state === 'FINALE_DROP') {
         config.dyeDecay = 0.997;
         // Inject IO with 4 colors
         const colors = [
           [0.26, 0.52, 0.96], // Blue 
           [0.92, 0.26, 0.21], // Red
           [1.00, 0.74, 0.02], // Yellow
           [0.20, 0.66, 0.33]  // Green
         ];
         const pts = getInjectionPoints('I/O');
         const minDim = Math.min(canvas.width, canvas.height);
         const scaleX = (minDim * 0.8) / canvas.width;
         const scaleY = (minDim * 0.8) / canvas.height;
         
         const progress = Math.min(sequenceTime / 0.25, 1.0);
         const intensityMult = progress * (dtElapsed * 60) * 1.5;
         
         pts.forEach((p, i) => {
            const ux = 0.5 + p.x * scaleX; 
            const uy = 0.5 + p.y * scaleY;

            let vx = ux - 0.5;
            let vy = uy - 0.5;
            const len = Math.sqrt(vx*vx + vy*vy) || 1;
            vx = (vx / len) * config.velocitySplat + rand(-30, 30);
            vy = (vy / len) * config.velocitySplat + rand(-30, 30);

            // Cycle colors based on index
            const color = colors[i % 4];

            injectionQueue.push({
              x: ux + rand(-0.005, 0.005),
              y: uy + rand(-0.005, 0.005),
              color: color,
              velocityX: vx,
              velocityY: vy,
              intensity: rand(0.7, 1.0) * intensityMult
            });
         });
         
         if (sequenceTime >= 0.5) {
             state = 'FINALE_HOLD';
             config.dyeDecay = 1.0; // Stop fading completely
             
             // Trigger text fade in after a brief delay
             setTimeout(() => {
                setFinaleTextVisible(true);
             }, 1000);
         }
      }

      runSimulation();
      animationFrameId = requestAnimationFrame(update);
    };

    update(performance.now());

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resizeCanvas);
    };
  }, []);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-white selection:bg-transparent">
      {/* WebGL Canvas */}
      <canvas 
        ref={canvasRef} 
        className="absolute inset-0 block w-full h-full z-0" 
      />

      {/* HUD - Countdown Details */}
      {!isFinale && (
        <>
          <div className="absolute bottom-8 right-8 flex flex-col items-end z-10 pointer-events-none fade-in">
            <span 
              className="text-6xl font-extralight tracking-tighter" 
              style={{ color: '#333333', opacity: 0.2, transition: 'color 0.2s ease-in-out' }}
            >
              {currentNumber}
            </span>
            <span 
              className="text-[10px] uppercase font-bold tracking-[6px] mt-1"
              style={{ color: '#333333', opacity: 0.1, transition: 'color 0.2s ease-in-out' }}
            >
              Ink Drop
            </span>
          </div>

          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex items-center justify-center z-10 pointer-events-none w-[200px] h-[2px] overflow-hidden rounded-full fade-in"
               style={{ backgroundColor: `#3333331A` }}>
             {/* Progress Bar Fill */}
             <div 
               className="h-full origin-left rounded-full"
               style={{ 
                 backgroundColor: `#33333333`, // 0.2 opacity approx
                 width: '100%',
                 animation: 'drain 1s linear infinite'
               }}
             />
          </div>
        </>
      )}

      {/* Finale Text removed as requested */}

      <style>{`
        @keyframes drain {
          from { transform: scaleX(1); }
          to { transform: scaleX(0); }
        }
        .fade-in {
          animation: fadeIn 1s ease-in forwards;
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
